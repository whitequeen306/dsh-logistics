# dsh-logistics 架构与执行模型（0.3.0）

> 本文描述 **0.3.0 已实现**的结构，不是路线图。0.3.0 把最终裁决交给主会话模型（“主编”），机器只保留事实、收集、contract 校验和安全边界；评分、基线、门禁已在 0.2.0 删除。模块取舍见 [MODULE-DECISION.md](./MODULE-DECISION.md)，0.1.0 的旧架构保留在 git 历史与 [master 分支](https://github.com/whitequeen306/dsh-logistics/tree/master)。

## 1. 一句话模型

```text
/logi-* 命令
  → 确定性 scope.json（改了哪些文件、测试命令、可用专家、模型路由）
  → 主会话模型（主编）读 scope，决定派发哪些专家
  → N 个只读专家 child，各写 handoff/<expert>.json
  → collect（盘点完整性，不是质量门禁）
  → bundle（候选材料 + 稳定 ID）
  → 主会话模型合并/去重/定级/取舍，写 verdict.json + report.md
  → verdict.mjs 校验 contract（不判断内容好坏）
  → 默认四模块完整时才更新 latest
```

关键点：**机器负责事实与安全边界，模型负责判断与成文。** 机器不再生成最终报告，也不再把“去重结果”当成唯一真相。

## 2. 分层

| 层 | 文件 | 职责 | 调模型 |
| --- | --- | --- | --- |
| 注册层 | `lib/index.js` | 加载 6 个 skill，注册 7 个命令 | 否 |
| 命令层 | `lib/commands.js` | 取 cwd、建 run、注入派发、处理 `/logi-fix` | 否（只入队） |
| 范围层 | `lib/scope.js` | git/文件扫描、忽略、测试命令、可选专家、模型路由、`scope.json` | 否 |
| 派发层 | `lib/dispatch.js` | 主编协议、child prompt、collect/bundle/verdict 命令 | 否 |
| 专家层 | `skills/logi-*/SKILL.md` + `subagent` | 每位专家一个只读 child；共享契约内联在专家 skill 中 | 是 |
| 收集层 | `lib/handoffs.js`、`lib/cli/collect.mjs` | 校验 handoff 完整性、section 计数、候选材料 | 否 |
| 裁决层 | `lib/verdict.js`、`lib/cli/verdict.mjs` | verdict contract 校验、稳定 ID、覆盖检查 | 否 |
| 修复层 | `lib/commands.js` `runFix`、`skills/logi-fix` | 从 verdict 选 direct finding，白名单/测试/回滚 | 是（单 child） |
| 配置层 | `lib/config.js`、`lib/constants.js` | 忽略、上限、测试命令、模块显示名、专家模型路由 | 否 |

依赖方向：

```text
index → commands → scope / config / dispatch / verdict
dispatch → constants
handoffs → findings / constants / util
verdict → findings / constants / util
cli → scope / handoffs / verdict
```

运行时**不 import 任何 `@deepseek-ai/*`**，只使用 `ctx.commands`、`ctx.skills`、`invocation.agent.followup` 和原生 `subagent` 工具。

## 3. 五个模块

| key | 命令 | 默认 | sections | 职责 |
| --- | --- | --- | --- | --- |
| `correctness` | `/logi-correctness` | 是 | logic, state, concurrency, contracts, edge-cases | 逻辑、状态、并发、契约、边界；架构/API 兼容/schema 迁移也归这里 |
| `security` | `/logi-security` | 是 | auth, injection, secrets, crypto, exposure, supply-chain | 信任边界、认证授权、注入、密钥、加密、暴露、供应链 |
| `reliability` | `/logi-reliability` | 是 | error-handling, tests | 吞错/传播/重试/幂等/部分失败/超时/可观测性 + 回归缺口 |
| `maintainability` | `/logi-maintainability` | 是 | simplify, cleanup | 行为保持的简化，以及未用依赖/孤儿文件/公开死代码 |
| `perf` | `/logi-perf` | 否 | performance | 热路径复杂度、N+1/索引、阻塞 I/O、重渲染、内存；只出 `plan` |

`/logi` 默认跑前四个。是否追加 `perf` 由**主编模型**读 scope 后判断：只有 diff 明确涉及热路径才加；不加时报告必须写“性能未覆盖”。

## 4. 命令与执行方法

| 命令 | 类型 | 子代理 | 写源码 |
| --- | --- | --- | --- |
| `/logi` | 多专家审查 | 4（可加 perf） | 否 |
| `/logi-correctness` | 单专家审查 | 1 | 否 |
| `/logi-security` | 单专家审查 | 1 | 否 |
| `/logi-reliability` | 单专家审查 | 1 | 否 |
| `/logi-maintainability` | 单专家审查 | 1 | 否 |
| `/logi-perf` | 单专家审查 | 1 | 否 |
| `/logi-fix` | 列出 / 计划 / 执行 | 0 或 1 | 仅执行时，受限 |

### 4.1 审查 handler

`runReport`（`lib/commands.js`）：

1. 从 `invocation.agent.session.header.cwd` 取工作区，回退 `process.cwd()`。
2. `gitRoot(cwd) ?? cwd` 作为项目根。
3. `loadConfig(root)` 合并 `.logistics/config.json`，包含 `models` 路由。
4. `createScope({ cwd, command, experts, notes, config })` 写 `.logistics/runs/<runId>/scope.json`。
5. 没有可分析文件时返回中文错误，不派发。
6. 生成 `buildSingleDispatch` 或 `buildPipelineDispatch`（内含逐字 child prompt、模型路由、collect/bundle/verdict 命令）。
7. `agent.followup(...)` 注入下一轮 user 消息。
8. 立即返回 `{kind:"success", text}`。

### 4.2 修复 handler

`runFix`：

- 无参数：列出最近一份**通过 contract 校验且覆盖完整**的 `verdict.json` 中的 `direct` ID。
- `--dry-run <ID...>`：输出位置、白名单、测试命令、步骤；不建 fix 目录、不派发。
- `<ID...>`：校验 schema、ID、`kind=direct`、非 `perf`、git 仓库、工作区干净、HEAD 未变；写 `selection.json`，派发一个 fixer。
- 不支持 `--all`，不支持 apply-then-revert。

## 5. 审查流水线

```text
/logi
  │
  ├─ 1. createScope
  │       git 状态 / diff / 最近提交 / 文件清单 / 测试命令 / 模型路由
  │       → .logistics/runs/<runId>/scope.json
  │
  ├─ 2. followup：主会话模型收到派发消息，成为主编
  │
  ├─ 3. 分波 subagent：每条 assistant 消息最多 4 个 child
  │       每个 child 只加载自己的专家 skill，只读，写 handoff/<expert>.json
  │
  ├─ 4. collect.mjs：盘点 received/missing/invalid/failed/partial
  │       missing/invalid 重试一次；第二次失败写 failed handoff
  │
  ├─ 5. bundle.mjs：生成 handoffs.json + packet.md + 稳定 ID
  │       主编自己读 packet 与原始 handoff，不只看机器摘要
  │
  ├─ 6. 主编裁决：合并/去重/定级/取舍
  │       → verdict.json + report.md
  │       → verdict.mjs 校验 contract
  │
  └─ 7. 默认四模块完整时更新 latest；中文汇报
```

规则：

- 未派发的专家不算 missing；已派发但没有 handoff 才算。
- `failed` 是终态，不重试。
- 没有 `subagent` 工具时硬停，**没有父代理自审降级**。
- `collect` 的 `complete` 只表示证据收齐，不表示审查通过；`verdict` 只校验 contract，不判断内容质量。
- 单模块或非默认组合只写本次 run，不覆盖 `docs/logistics/latest.md` 与 `.logistics/latest.json`。

## 6. 子代理协议

### 6.1 创建

`buildChildPrompt({ expertKey, scope })` 是 child prompt 的**唯一来源**（`lib/dispatch.js`）。父代理直接把 `buildPipelineDispatch` / `buildSingleDispatch` 中的 prompt 逐字传给 `subagent`：

```js
subagent({
  description: "logi-<expert>",
  prompt: "<buildChildPrompt 的完整内容>",
  // 仅当 DSH 开启子代理模型选择且项目配置了该专家路由时：
  // provider, model, reasoning_effort
})
```

`provider`/`model` 不是普通参数：只有 `modelSelectionSettings` 开启、provider 支持 `agentOptions`、且路由在允许列表内才可传；否则去掉重试，回退父会话模型。

### 6.2 专家 child 的硬约束

- 只读；不编辑源码、不提交、不删除、不嵌套 subagent。
- 只负责一个模块；只加载自己的专家 skill。
- 每条 finding 必须有位置、证据、触发路径、影响。
- 必须声明所有 section 的检查计数；计数与 findings 不一致会被判无效。
- 只写自己的 `handoff/<expert>.json`；不读其他 child 的 handoff。

### 6.3 handoff

```json
{
  "schemaVersion": 2,
  "expert": "security",
  "status": "ok",
  "summary": "非空中文摘要",
  "sections": { "auth": 0, "injection": 1, "secrets": 0 },
  "findings": [],
  "deferred": [],
  "notes": ""
}
```

`sections` 的每个计数必须等于该 section 的 findings 条数；未知 section、负数、缺失 section 都判无效。

## 7. 报告与数据契约

### 7.1 产物

```text
.logistics/runs/<runId>/
  scope.json
  handoff/<expert>.json
  handoffs.json          # bundle：候选 finding + 覆盖
  packet.md              # 给主编的候选材料
  verdict.json           # 主编裁决
  report.md              # 人读报告
.logistics/latest.json   # 仅默认四模块完整时更新
docs/logistics/latest.md # 仅默认四模块完整时更新
.logistics/fixes/<fixRunId>/
  selection.json
  fix.json
  fix-reverted.patch     # 仅失败回滚时出现
```

### 7.2 finding

```json
{
  "id": "SEC-4F2A1",
  "expert": "security",
  "module": "src/auth",
  "section": "auth",
  "severity": "high",
  "confidence": "high",
  "title": "一句话问题",
  "file": "src/auth/session.js",
  "line": 42,
  "evidence": "可复现证据",
  "impact": "后果",
  "kind": "direct",
  "fix": {
    "summary": "怎么修",
    "steps": ["步骤 1", "步骤 2", "步骤 3"],
    "files": ["src/auth/session.js"],
    "tests": ["回归测试"]
  }
}
```

- `kind: direct` 才允许 `/logi-fix`；`plan` 只出方案。
- 性能项永远是 `plan`。
- 没有证据的 critical/high 会被降级；`fix` 不完整会被降为 `plan`。

### 7.3 ID 与去重

- ID：`PREFIX + sha1(expert|category|file|normalizeTitle(title))` 前 5 位；不含行号，同 run 冲突自动扩到 6–8 位。
- 跨专家去重由**主编**做；`bundle.mjs` 只给 `duplicateHints`，不替主编删除。
- 机器仍保证 ID 稳定，方便 `/logi-fix` 引用。

### 7.4 模块归属

`moduleOf(file)`：

- `packages/*`、`apps/*` 取两段；
- 去掉 `src`/`lib`/`app` 公共根后取首段；
- 单段目录归该目录，根文件归 `(root)`；
- 可用 `config.modules` 覆盖显示名。

### 7.5 覆盖

`coverage` 记录 expected / received / missing / invalid / failed / partial / complete。

- `complete` 只表示“默认四位都收到合法 handoff”；
- 单模块也算 complete，但**不可发布 latest**；
- `latest` 只由默认四模块完整覆盖更新。

## 8. 修复执行

`/logi-fix` 是唯一写入口，串行、单 fixer：

1. 从最近完整 `verdict.json` 读 `direct` 项；没有则报错。
2. 要求 git 仓库、工作区干净（生成物除外）、HEAD 未变。
3. 写 `selection.json`，记录 verdictRunId、ID、白名单文件、测试命令。
4. fixer 只改白名单，跑 `scope.testCommand`；失败先存 `fix-reverted.patch`，回滚该组，写 `fix.json`。
5. 不 commit、不 push、不安装依赖、不联网；不做 `--all`。

## 9. 只读与限制

- 审查 child 有写工具，但 prompt 要求只读；真正的安全边界是**文件白名单 + 修复阶段串行 + 不自动提交**。
- 审查阶段不改变工作区；源码在审查期间变化会让证据过期，`/logi-fix` 会拒绝。
- 静态分析不是编译器：跨仓库、运行时问题可能漏报。
- 模型裁决可能主观；机器保留原始 handoff、候选 ID、contract 错误，便于人工复核。

## 10. 扩展

### 加一个 section

1. `lib/constants.js` 的 `EXPERT_LIST[].sections` 加入 section。
2. 对应专家 skill 增加检查项与证据要求。
3. `test/skills.test.js` 会校验 section 覆盖。

### 加一个专家

1. `lib/constants.js` 增加 key/title/sections/prefix/skill。
2. 新建 `skills/logi-<key>/SKILL.md`（内联共享契约）。
3. 加 `/logi-<key>` 命令（`EXPERT_LIST` 自动生成）。
4. 默认/可选列表、README、测试同步。

### 加一个命令

在 `lib/commands.js` 的 `createCommands` 加 definition；handler 只做确定性工作或注入主编派发消息。

## 11. 已知风险

1. DSH 子代理模型选择未开启时，`models` 配置会静默回退父模型。
2. Linux/macOS 没有安装 `node` 时，派发命令依赖 `process.execPath`；Desktop 内置 Node 路径可能不在 PATH。
3. 审查 child 的只读是 prompt 级；没有独立只读文件系统隔离。
4. 审查期间源码变化会使证据过期；当前只在 `/logi-fix` 硬检查。
5. 主编可能漏掉跨专家重复或证据冲突；`packet.md` 提供 hints，但不强制。
6. `collect` 只做格式/完整性校验，不做语义质量判断。
7. 大改动截断后可能漏掉重要文件；报告必须标明 omitted。
8. 没有机器门禁：是否阻塞合并由人和 CI 决定。

## 12. 文件索引

- 入口：`lib/index.js`
- 命令：`lib/commands.js`
- 范围：`lib/scope.js`
- 派发：`lib/dispatch.js`
- handoff：`lib/handoffs.js`
- 裁决：`lib/verdict.js`
- finding/ID/模块：`lib/findings.js`
- 配置：`lib/config.js`、`lib/constants.js`
- CLI：`lib/cli/collect.mjs`、`bundle.mjs`、`verdict.mjs`
- 专家 skill：`skills/logi-correctness|security|reliability|maintainability|perf/SKILL.md`
- 修复 skill：`skills/logi-fix/SKILL.md`
- 测试：`test/*.test.js`（56 个）
