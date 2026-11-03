# dsh-logistics 架构与执行模型（0.2.2）

> 本文描述 **0.2.2 已实现**的结构，不是路线图。0.2.2 把共享契约折叠进每个专家 skill，删除了独立的 `logi-core` / `logi-pipeline`；模块取舍的决策记录见 [MODULE-DECISION.md](./MODULE-DECISION.md)。0.1.0 的 7 专家/评分架构保留在 git 历史与 [旧版 master](https://github.com/whitequeen306/dsh-logistics/tree/master) 中。

## 1. 一句话模型

```text
确定性命令层 → 范围快照 → 模型派发 → 编排 skill → 5 位专家子代理 + 专家 skill
                                                          ↓
                                                     handoff JSON
                                                          ↓
                                     确定性聚合：去重 / 稳定 ID / 模块分组 / Markdown
```

关键点：**模型只负责审查与编排；范围、去重、ID、模块归属、报告和修复安全边界由零依赖 Node 代码负责。** 报告里没有分数，也没有基线门禁。

## 2. 分层

| 层 | 文件 | 职责 | 调模型 |
| --- | --- | --- | --- |
| 注册层 | `lib/index.js` | 加载 skill，注册 7 个命令 | 否 |
| 命令层 | `lib/commands.js` | 取 cwd、建 run、注入派发、处理 `/logi-fix` | 否（只入队） |
| 范围层 | `lib/scope.js` | git/文件扫描、忽略、模块文件清单、测试命令、`scope.json` | 否 |
| 派发层 | `lib/dispatch.js` | 生成父代理可见的审查/修复 prompt 与 CLI 命令；child prompt 的唯一来源 | 否 |
| 专家层 | `skills/logi-*/SKILL.md` + `subagent` | 每位专家一个只读 child；共享契约内联在专家 skill 中，写 handoff | 是 |
| 后处理层 | `lib/report.js`、`lib/findings.js`、`lib/cli/*.mjs` | 校验、去重、ID、模块报告、覆盖状态 | 否 |
| 修复层 | `lib/commands.js` `runFix`、`skills/logi-fix` | 选择 finding、创建 fixer、白名单/测试/回滚 | 是（单 child） |
| 配置层 | `lib/config.js`、`lib/constants.js` | 忽略、上限、测试命令、模块显示名 | 否 |

依赖方向：

```text
index → commands → scope / config / dispatch / report
dispatch → constants
report → findings / constants / util
cli → scope / config / report
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

- `/logi` 默认跑前四个；`perf` 需要显式 `/logi-perf`。
- 每个模块的 section 必须在 handoff 里有覆盖声明；缺 section 视为无效 handoff。
- 不设第 6 个模块：可观测性进 `reliability`，文档问题在 `maintainability` 最多一条 `info`。

## 4. 命令与执行方法

| 命令 | 类型 | 子代理 | 写源码 |
| --- | --- | --- | --- |
| `/logi` | 多专家审查 | 4 | 否 |
| `/logi-correctness` | 单专家审查 | 1 | 否 |
| `/logi-security` | 单专家审查 | 1 | 否 |
| `/logi-reliability` | 单专家审查 | 1 | 否 |
| `/logi-maintainability` | 单专家审查 | 1 | 否 |
| `/logi-perf` | 单专家审查 | 1 | 否 |
| `/logi-fix` | 列出 / 计划 / 执行 | 0 或 1 | 仅执行时，受限 |

没有 `quick/standard/full` 档位，也没有 `gate` 命令。默认四模块覆盖 6/7 个领域；`perf` 是可选正交维度。

### 4.1 审查 handler

`runReport`（`lib/commands.js:62`）：

1. 从 `invocation.agent.session.header.cwd` 取工作区，回退 `process.cwd()`。
2. `gitRoot(cwd) ?? cwd` 作为项目根。
3. `loadConfig(root)` 合并 `.logistics/config.json`。
4. `createScope({ cwd, command, experts, notes, config })` 写 `.logistics/runs/<runId>/scope.json`。
5. 没有可分析文件时返回中文错误，不派发。
6. 生成 `buildSingleDispatch` 或 `buildPipelineDispatch`。
7. `agent.followup({ role:"user", id:randomUUID(), content:[{type:"text",text}], source:{kind:"user"} })`。
8. 立即返回 `{kind:"success", text}`。

命令 handler 不调用模型、不写源码、不调用 `present`；它只把下一轮的派发消息放进 inbox。

### 4.2 修复 handler

`runFix`（`lib/commands.js:178`）：

- 无参数：列出最近完整报告里的 `direct` ID。
- `--dry-run <ID...>`：输出位置、白名单、测试命令、步骤；不建 fix 目录、不派发。
- `<ID...>`：校验 schema、ID、`kind=direct`、非 `perf`、git 仓库、工作区干净、HEAD 未变；写 `selection.json`，派发一个 fixer。
- 不支持 `--all`，不支持 apply-then-revert。

## 5. 审查流水线

```text
/logi
  │
  ├─ 1. createScope：git 状态 / diff / 最近提交 / 文件清单 / 测试命令
  │       → .logistics/runs/<runId>/scope.json
  │
  ├─ 2. followup：父代理收到派发消息；消息自带完整编排协议
  │
  ├─ 3. 分波 subagent：每条 assistant 消息最多 4 个 child
  │       每个 child 只加载自己的专家 skill（共享契约内联在 skill 中），只读，写 handoff
  │
  ├─ 4. 完成通知 → status.mjs --expect <experts>
  │       missing/invalid 重试一次；第二次失败写 failed handoff
  │
  ├─ 5. aggregate.mjs --run <runDir>
  │       校验、跨专家去重、稳定 ID、模块分组、报告
  │
  └─ 6. 父代理读 docs/logistics/latest.md，中文汇报
```

规则：

- 未派发的专家不算 missing；已派发但没有 handoff 才算。
- `failed` 是终态，不重试。
- 没有 `subagent` 工具时硬停，**没有父代理自审降级**。
- 覆盖不完整时 `aggregate` 退出 3，且不更新 `latest`。

## 6. 子代理协议

### 6.1 创建

父代理调用：

```text
subagent({
  description: "logi-<expert>",
  prompt: <buildChildPrompt 生成的完整 prompt>
})
```

不传 `provider`。`subagent` 的模型参数只有 `cwd`、`description`、`prompt`（配置允许时还有 `agent_preset`）；`provider` 是 composition 的后端选择。

### 6.2 专家 child 的硬约束

- 只读：不改源码、不删除、不提交、不跑格式化/codemod。
- 只做一个专家；其它领域写 `deferred`。
- 每个 finding 必须有位置、证据、触发路径、影响；没有证据不报。
- `critical/high` 不允许 `confidence: low`；无证据会被降级为 `low` 且不计入统计。
- 最多 12 条，按严重度排序。
- 不嵌套子代理、不调用 `present`、不向用户提问。
- 先写 handoff，再回复。

### 6.3 handoff

```json
{
  "schemaVersion": 2,
  "expert": "correctness",
  "status": "ok",
  "summary": "中文 1-3 句，不能为空",
  "sections": {
    "logic": 2,
    "state": 0,
    "concurrency": 1,
    "contracts": 0,
    "edge-cases": 1
  },
  "findings": [],
  "deferred": [],
  "notes": ""
}
```

- `status`：`ok | partial | failed`。
- `partial` 表示只完成部分 section；报告标为部分覆盖，不更新 `latest`。
- `failed` 必须有 `error`。
- `sections` 必须覆盖该专家的全部 section；缺失或计数与 findings 不一致会被判 invalid。
- `summary` 为空会判 invalid，避免“空 handoff 拿满分”。

## 7. 报告与数据契约

### 7.1 产物

```text
.logistics/runs/<runId>/
  scope.json
  handoff/<expert>.json
  report.json
  report.md
.logistics/latest.json
docs/logistics/latest.md        # 仅 coverage.complete 时更新
.logistics/fixes/<fixRunId>/
  selection.json
  fix.json
  fix-reverted.patch            # 仅失败回滚
```

### 7.2 finding

```json
{
  "id": "SEC-4F2A1",
  "expert": "security",
  "experts": ["security"],
  "module": "packages/api",
  "section": "injection",
  "category": "injection",
  "severity": "high",
  "confidence": "high",
  "title": "订单查询把用户输入拼进 SQL",
  "file": "packages/api/src/orders.js",
  "line": 42,
  "evidence": "字符串拼接后直接传给 query()",
  "impact": "攻击者可读取任意订单",
  "fix": {
    "summary": "改用参数化查询",
    "steps": ["定位拼接点", "改为占位符", "补注入测试"],
    "files": ["packages/api/src/orders.js"],
    "tests": ["orders.test.js: 注入字符串不应改变 SQL"]
  },
  "kind": "direct"
}
```

- `kind: direct`：机械、行为保持、可验证的修复。
- `kind: plan`：需要设计决策；`perf` 永远为 `plan`。
- 没有 `ruleId`、`autoFixable`、分数。

### 7.3 ID 与去重

- 指纹：`sha1(expert | category | file | normalizeTitle(title))`，**不含行号**。
- ID：专家前缀 + 5 位大写 hash，例如 `COR-4F2A1`；同 run 冲突时扩到 6 位以上。
- 跨专家去重键：`category | file | normalizedTitle`，不含 expert；合并后保留最严重级别/最高置信度，并合并 `experts`。
- 排序：severity 主序；同级 `security > correctness > reliability > maintainability > perf` 只是 tiebreak，不是权重。

### 7.4 模块归属

`moduleOf(file, config)`（`lib/findings.js:329`）：

1. 配置了 `modules` 的显示名优先。
2. `packages/*`、`apps/*` 取两段，例如 `packages/api`。
3. 去掉 `src`/`lib`/`app` 前缀后取首段。
4. 根级文件归 `(root)`。
5. `package.json`/锁文件等归 `dependencies`。

模块由 JS 确定，子代理不自报模块名。

### 7.5 覆盖

- `coverage.expected`：本次请求的专家。
- `completed`：status `ok` 的专家。
- `partial` / `failed` / `missing` / `invalid`：分别记录。
- `complete`：请求的专家全部 `ok`。
- `full`：全 5 位专家且 `complete`。`/logi` 默认 4 位，`complete=true` 但 `full=false`；这不影响 `latest` 更新。
- 只有 `complete` 才更新 `latest.md` / `latest.json`。

## 8. 修复执行

```text
/logi-fix <ID>
  │
  ├─ 读 latest.json → report.json
  ├─ 校验：schemaVersion 2 / ID 存在 / kind=direct / 非 perf
  ├─ 校验：git 仓库 / 工作区干净 / HEAD 与报告一致
  ├─ 写 .logistics/fixes/<fixRunId>/selection.json
  ├─ 派发一个 fixer（skills/logi-fix）
  │    ├─ 只改白名单文件
  │    ├─ 跑 testCommand
  │    ├─ 失败：保存 fix-reverted.patch → 回滚 → 标记 failed/partial
  │    └─ 写 fix.json
  └─ 不 commit / 不 push / 不装依赖
```

安全边界：

- 只允许 `direct`；`plan` 和 `perf` 拒绝。
- 允许文件来自 finding 的 `fix.files`，缺省是 `finding.file`。
- 改动必须 ⊆ 白名单；越界立即停止。
- 工作区必须在修复前干净；报告生成后 HEAD 不能变。
- 测试失败不保留半成品：先存 patch，再回滚本次改动。
- 不做多专家并行修改，也不做 apply-then-revert。

## 9. 只读与限制

- 审查命令对源码只读；但 child 仍拥有写工具，**只读是 prompt 级约束，不是工具权限**。目前没有聚合前的源码树守卫；这是已知风险（见 §11）。
- `/logi-fix` 的写权限由 handler 的前置校验 + fixer skill 的白名单共同限制，不是 DSH 沙箱。
- 非 git 工作区可以审查，但不能执行 `/logi-fix`。
- 生成物 `.logistics/`、`docs/logistics/` 永远排除在范围、脏检查和 staleness 之外。

## 10. 扩展

### 加一个 section

1. `lib/constants.js` 的对应 expert `sections` 增加名字。
2. 对应 `skills/logi-<expert>/SKILL.md` 增加检查清单和 evidence 要求。
3. 更新 `test/skills.test.js` 的 section 覆盖断言。

### 加一个专家

1. `lib/constants.js` 的 `EXPERT_LIST` 增加 `{key,title,skill,expert,prefix,domain,focus,sections}`。
2. 新建 `skills/logi-<key>/SKILL.md`。
3. 单专家命令自动由 `EXPERT_LIST.map` 生成；`/logi` 默认列表按需加入 `DEFAULT_EXPERTS`。
4. 更新 README 命令表、`test/commands.test.js` 的命令数、`test/skills.test.js` 的目录数。
5. 若参与默认审查，确认 `max 4/wave` 与报告模块分组仍合理。

### 加一个命令

- 审查类：复用 `reportSpec` + `runReport`，传专家列表。
- 确定性类：只写 handler，不 `followup`。
- 修复类：必须复用 `runFix` 的校验和 `buildFixDispatch`，不要新开写路径。

## 11. 已知风险

1. **只读不是硬约束**：child 有写工具；当前靠 prompt + 事后审查。建议后续在派发前记录 `git status`/diff hash，聚合前复算并拒绝越界改动。
2. **Node 运行时**：Desktop 主进程是 Electron，`process.execPath` 通常不是 `node`；`dispatch.js` 会退回 PATH 上的 `node`。未装 Node 的用户可能在 status/aggregate 阶段失败。Desktop 自带 Node 在 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`，后续应优先解析它。
3. **完成通知语义**：不同 DSH 版本/后端可能批量或延迟投递；父代理必须幂等，不能重复派发同一专家。
4. **真实 UI 未点击验证**：Desktop 已热加载 skill，证明 `apply` 到达注册阶段；`/logi-*` 的 UI 级执行与 `agent.followup` 唤醒仍需 smoke test。
5. **证据仍是模型判断**：静态审查可能漏掉运行时/跨仓库问题；报告用置信度和覆盖状态表达不确定性，而不是分数。
6. **大改动上限**：默认 400 文件、单专家 12 条；超大 PR 建议拆分或提高 `maxFiles`。
7. **市场收录**：catalog PR 未提交；与代码正确性无关。

## 12. 文件索引

- 入口：`lib/index.js`
- 命令/修复：`lib/commands.js`
- 范围：`lib/scope.js`
- 派发：`lib/dispatch.js`
- 报告：`lib/report.js`
- finding/ID/模块：`lib/findings.js`
- 配置/常量：`lib/config.js`、`lib/constants.js`
- CLI：`lib/cli/status.mjs`、`lib/cli/aggregate.mjs`
- 契约与专家：`skills/logi-correctness|security|reliability|maintainability|perf/SKILL.md`
- 修复：`skills/logi-fix/SKILL.md`
- 测试：`test/*.test.js`（49 个）
