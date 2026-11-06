# dsh-logistics 架构与执行模型（0.8.2）

> 本文描述 **0.8.2 已实现**的结构，不是路线图。0.4.0 把审查范围从「工作区 diff / 最近提交」改成**整个项目**：`git ls-files` 全量清单 → 文件分类 → 模块切分 → 审查单元；每个专家覆盖全部单元，并用 handoff 的 `units` 映射声明 reviewed / sampled / skipped。0.5.0 把 `report.md` 定为核心交付物，要求每位专家另写报告，并由 `lib/report-check.js` 做 contract 校验。0.5.1 给 run 目录加命令后缀（`/logi` 为 `-master`，单专家为 `-<expert>`），并让 `/logi` 的 handoff 按专家分目录，旧平铺 run 仍可读。0.6.0 移除 `/logi-fix` 与独立 fixer，插件不提供写操作命令；审查子代理仍受 prompt 约束，需要修复时由用户把报告或 finding 交给主模型。0.6.1 在报告 contract 校验前加入确定性脱敏与残留凭据扫描；0.6.2 细化 DSH 命令面板中的审查范围描述；0.6.3 把脱敏扩展到 run 目录下全部文本产物，增加结构化测试证据与 `direct`/`plan` 报告分区；0.6.4 把总报告改为按严重度排序并标注所属单元，并生成 `graph.json` + `graph.html` 关系图；0.6.5 要求 finding 先写面向非开发者的 `brief`，再写详细问题、证据、影响和修复；0.6.6 为每个单元增加核心必读清单和最低实际读取数，handoff 必须列出实际读过的文件；0.6.7 把脱敏扩展到 `.bak`、临时脚本等常规文本产物，`latest` 只由最终 contract 通过的默认 `/logi` 发布，并要求模型删除自己创建的临时文件；0.7.0 将性能纳入默认 `/logi`，补齐 maintainability 的耦合度、reliability 的 resilience/observability、security 的业务逻辑滥用，并清理 correctness/security 的 diff 语义；0.8.0 增加启动 ETA、`progress.json`/`children.json`、`/logi-status`、`/logi-cancel` 和按波次更新的进度检查点；0.8.1 清零终态 ETA、完成时写入单元覆盖数、把超过 2 小时无心跳的 run 标记为 stale failed，并在最终校验时警告 run 根目录临时文件和跨专家测试状态冲突；0.8.2 保护终态不被迟到的 verdict 阶段覆盖，写入 `children.json` 的 `runId`，用已启动专家反推波次，并在关系图生成后再次脱敏、把 warning 写入 `verdict.validated` 日志。0.3.x 的主编模型、contract 校验和运行日志继续保留。

## 1. 一句话模型

```text
/logi-* 命令
  → 确定性 scope.json（全项目文件、模块、审查单元、测试命令、模型路由）
  → 主会话模型（主编）读 scope，派发专家
  → 每位专家一个只读 child，覆盖全部单元，写 handoff/<expert>/<expert>.json + .md（/logi；单专家平铺）
  → collect（盘点专家 + 单元覆盖，不是质量门禁）
  → bundle（候选材料 + 稳定 ID + 单元 × 专家矩阵）
  → 主会话模型合并/去重/定级/取舍，写 verdict.json + report.md
  → verdict.mjs 先脱敏本次 run 的全部常规文本产物，再校验 contract（含 report.md、专家报告、测试证据、direct/plan 分区与严重度排序；不判断内容好坏）
  → 生成 graph.json + graph.html（模块/问题/关系图）
  → 默认五专家完整且最终 contract 通过时才更新 latest
```

关键点：**机器负责事实与安全边界，模型负责判断与成文。** 一个专家一个 child，不是「单元 × 专家」几十个 child；覆盖是否真实由 handoff 的单元映射和机器校验共同约束。

## 2. 分层

| 层 | 文件 | 职责 | 调模型 |
| --- | --- | --- | --- |
| 注册层 | `lib/index.js` | 加载 5 个 skill，注册 8 个命令 | 否 |
| 命令层 | `lib/commands.js` | 取 cwd、建 run、注入全项目派发、生成运行回复 | 否（只入队） |
| 项目层 | `lib/project.js` | 文件分类、模块归属、审查单元、上限与合并 | 否 |
| 范围层 | `lib/scope.js` | git 清单、项目 scope 落盘、测试命令、模型路由 | 否 |
| 路径层 | `lib/handoff-paths.js` | run 目录后缀、嵌套/平铺 handoff 路径、旧 run 兼容 | 否 |
| 派发层 | `lib/dispatch.js` | 主编协议、child prompt、collect/bundle/verdict 命令 | 否 |
| 专家层 | `skills/logi-*/SKILL.md` + `subagent` | 每位专家一个只读 child；共享契约内联在专家 skill 中 | 是 |
| 收集层 | `lib/handoffs.js`、`lib/cli/collect.mjs` | 校验 handoff、section 计数、单元覆盖、专家报告索引、候选材料 | 否 |
| 报告层 | `lib/report-check.js`、`lib/redact.js`、`lib/test-command.js` | 全部文本产物脱敏与残留扫描、report.md / 专家报告 / 测试证据 / direct-plan 分区 / 严重度排序 contract 校验、多测试命令展示 | 否 |
| 图形层 | `lib/graph.js` | 由 verdict 生成 graph.json 与自包含 graph.html（模块/问题/关系） | 否 |
| 裁决层 | `lib/verdict.js`、`lib/cli/verdict.mjs` | verdict contract 校验、稳定 ID、覆盖检查、报告校验 | 否 |
| 配置层 | `lib/config.js`、`lib/constants.js` | 忽略、上限、测试命令、模块显示名、专家模型路由 | 否 |
| 日志层 | `lib/runlog.js`、`lib/progress.js` | `run.jsonl`、`progress.json`、`children.json`、`dispatch.md`、`prompts/` | 否 |

依赖方向：

```text
index → commands → scope / project / config / dispatch / verdict
dispatch → constants
handoffs → findings / constants / util
verdict → findings / constants / util / handoffs
cli → scope / handoffs / verdict
```

运行时**不 import 任何 `@deepseek-ai/*`**，只使用 `ctx.commands`、`ctx.skills`、`invocation.agent.followup` 和原生 `subagent` 工具。

## 3. 五个专家

| key | 命令 | 默认 | sections | 职责 |
| --- | --- | --- | --- | --- |
| `correctness` | `/logi-correctness` | 是 | logic, state, concurrency, data-integrity, contracts, architecture, edge-cases | 逻辑、状态、并发、数据完整性、契约、架构边界、边界输入 |
| `security` | `/logi-security` | 是 | auth, authz, injection, browser, uploads, secrets, crypto, exposure, business-logic, supply-chain | 信任边界、认证、授权、注入、浏览器、上传、密钥、加密、暴露、业务逻辑滥用、供应链 |
| `reliability` | `/logi-reliability` | 是 | error-handling, resilience, observability, tests | 吞错/传播/重试/幂等/部分失败/超时/背压/降级/可观测性 + 回归缺口 |
| `maintainability` | `/logi-maintainability` | 是 | simplify, coupling, cleanup | 结构、耦合/依赖方向、可测试性、API 表面、死代码、依赖、配置孤儿 |
| `perf` | `/logi-perf` | 是 | hot-path, data-access, runtime, frontend, memory-startup | 热路径复杂度、数据库访问、运行时阻塞、前端渲染/包体、内存/启动；只出 `plan` |

`/logi` 默认跑五位专家，`perf` 已纳入默认范围；`/logi-perf` 用于只重跑性能维度。报告必须给出性能判断；没有证据时写“未验证/未覆盖”。

## 4. 命令与执行方法

| 命令 | 类型 | 子代理 | 写源码 |
| --- | --- | --- | --- |
| `/logi` | 多专家全项目审查 | 5 | 否 |
| `/logi-correctness` | 单专家全项目审查 | 1 | 否 |
| `/logi-security` | 单专家全项目审查 | 1 | 否 |
| `/logi-reliability` | 单专家全项目审查 | 1 | 否 |
| `/logi-maintainability` | 单专家全项目审查 | 1 | 否 |
| `/logi-perf` | 单专家全项目审查 | 1 | 否 |

没有 `/logi-diff`，没有 `--diff`，没有“工作区模式”命令。`createScope` 内部保留 `mode='changes'` 仅用于旧测试与兼容调用；所有注册命令固定传 `mode:'project'`。

### 4.1 审查 handler

`runReport`（`lib/commands.js`）：

1. 从 `invocation.agent.session.header.cwd` 取工作区，回退 `process.cwd()`。
2. `gitRoot(cwd) ?? cwd` 作为项目根。
3. `loadConfig(root)` 合并 `.logistics/config.json`，包含 `project` 上限和 `models` 路由。
4. `createScope({ cwd, command, experts, notes, config, mode: 'project' })` 写 `.logistics/runs/<runId>-<master|expert>/scope.json`。
5. 没有任何可分析文件时返回中文错误，不派发。
6. 生成 `buildProjectDispatch`（内含逐字 child prompt、单元清单、模型路由、collect/bundle/verdict 命令、report.md 与专家报告要求）。
7. `agent.followup(...)` 注入下一轮 user 消息。
8. 立即返回 `{kind:"success", text}`；回复把 `report.md` 标为“核心交付物”，并列出全部测试命令。

### 4.2 修复（插件外）

插件不注册修复命令，也没有独立 fixer。审查结束后，用户可以把 `report.md` 或指定 finding ID 发给当前主模型继续处理。

## 5. 全项目范围

`lib/project.js` 做纯确定性工作，任何模型看到文件之前，范围已经固定。

### 5.1 文件清单

```text
git ls-files --cached --others --exclude-standard -z
  → 去重、toPosix、排序
  → 过滤 ignore（node_modules/dist/锁文件/.logistics 等）
  → isProjectFile(path)
  → countLines(path)（<=1MB 且非二进制）
```

`isProjectFile` 保留：

- 源码扩展名：JS/TS/JSX/TSX、Python、Go、Rust、Java/Kotlin、C#、Ruby、PHP、Swift、Scala、C/C++、Vue/Svelte/Astro、CSS/SCSS、HTML、Shell/PowerShell、SQL、GraphQL。
- 配置与构建描述：`package.json`、`pom.xml`、`build.gradle*`、`requirements.txt`、`pyproject.toml`、`go.mod`、`Cargo.toml`、`Dockerfile`、`docker-compose*`、`nginx.conf`、`.env.example`、`tsconfig.json`、各 bundler/linter 配置，以及根层/配置目录的 YAML/JSON/XML/TOML/properties。

排除：文档、示例/测试夹具、静态资源、`public`、`dist/build/out/target/coverage`、`node_modules/vendor`、锁文件、`.logistics` 与 `docs/logistics` 生成物、空文件/二进制/超大文件。

### 5.2 模块与单元

```text
moduleKeyFor(path):
  packages|apps|services|modules|libs|crates|backend|frontend/<name> → 两段
  其他 → 首段；根文件 → (root)

groupUnits:
  按 moduleKey 分组
  → 每 group 按 maxFilesPerUnit 切块，标签 `module (1/N)`
  → 单元数超过 maxUnits 时反复合并最小的两个
     - 同前缀 → `backend（小模块合集 59 文件）`
     - 跨前缀 → `其他模块（admin、config、.github 等）`
  → 按文件数降序，重编 u01..uNN
```

默认：

```json
{ "maxFiles": 2000, "maxFilesPerUnit": 120, "maxUnits": 12, "minFilesPerUnit": 30 }
```

每个单元还会计算 `core`：构建/配置（`package.json`、`pom.xml` 等）、入口（`main`/`index`/`app`/`server` 等）、认证/安全/中间件、迁移/schema、路由/控制器/服务链路，再补最大文件，最多 12 个。`core` 是“不能不看”的最小链路；专家实际读过的文件写在 handoff 的 `units[].files`，必须覆盖 `core` 且达到 `minFilesPerUnit`（单元更小则全读）。

`buildProjectPlan({ root, config })` 返回：

```json
{
  "files": [{ "path": "src/a.js", "status": "present", "lines": 10 }],
  "units": [{ "id": "u01", "label": "src", "core": ["src/main.js"], "files": [], "stats": { "files": 2, "lines": 30, "coreFiles": 1 } }],
  "totals": { "trackedFiles": 1488, "reviewedFiles": 1102, "omittedFiles": 386,
              "truncated": false, "units": 12, "coreFiles": 144, "lines": 150079 }
}
```

单元**没有 assignment**：不会生成「u01 归 correctness」这种矩阵；每位专家都覆盖全部单元。

### 5.3 scope 形状

```json
{
  "schemaVersion": 2,
  "version": "0.8.2",
  "runId": "20261104-...",
  "mode": "project",
  "source": "project",
  "root": "C:/path/project",
  "git": { "branch": "main", "head": "abc123", "dirty": false },
  "stats": { "analyzedFiles": 1102, "additions": 150079, "deletions": 0, "truncated": false },
  "experts": ["correctness", "security", "reliability", "maintainability", "perf"],
  "optionalExperts": [],
  "project": { "minFilesPerUnit": 30, "units": [], "totals": {} },
  "files": [],
  "testCommand": { "command": "mvn test", "source": "pom.xml" },
  "output": { "runDir": "...", "handoffDir": "...", "verdictJson": "...", "reportMarkdown": "..." }
}
```

`stats.additions` 在 project 模式表示**总行数**（历史字段名保留，展示时写“行”）。非 git 目录直接报错：`全项目模式需要 git 仓库；当前目录不在 git 工作区。`

## 6. 审查流水线

```text
/logi
  │
  ├─ 1. createScope（全项目）
  │       git ls-files → 分类 → 单元 → scope.json
  │
  ├─ 2. followup：主会话模型收到派发消息，成为主编
  │
  ├─ 3. 分波 subagent：每条 assistant 消息最多 4 个 child
  │       每位 child 收到完整单元清单 + 自己的专家 skill
  │       只读，写 handoff/<expert>/<expert>.json（含 units 映射；单专家平铺）
  │
  ├─ 4. collect.mjs：盘点专家 received/missing/invalid/failed/partial
  │       并打印每个单元的 reviewed/sampled/skipped/missing
  │       missing/invalid 重试一次；第二次失败写 failed handoff
  │
  ├─ 5. bundle.mjs：生成 handoffs.json + packet.md + 稳定 ID + 单元 × 专家矩阵
  │       主编自己读 packet 与原始 handoff，不只看机器摘要
  │
  ├─ 6. 主编裁决：合并/去重/定级/取舍
  │       → verdict.json + report.md
  │       → verdict.mjs 校验 contract
  │
  └─ 7. 默认五专家完整且最终 contract 通过时更新 latest；中文汇报
```

规则：

- 未派发的专家不算 missing；已派发但没有 handoff 才算。
- `failed` 是终态，不重试。
- 没有 `subagent` 工具时硬停，**没有父代理自审降级**。
- `collect` 的 `complete` 只表示证据收齐，不表示审查通过；`verdict` 只校验 contract。
- 单模块或非默认组合只写本次 run，不覆盖 `docs/logistics/latest.md` 与 `.logistics/latest.json`；默认 `/logi` 也只由 `verdict.mjs` 在最终报告和 verdict 都通过 contract 后发布 latest。

## 6.1 进度与取消

每次 `/logi*` 启动时由 `lib/commands.js` 调用 `startProgress(scope)`，写 `progress.json` 并记录 `run.started`。`lib/progress.js` 维护：

- `status`：`running` / `cancelling` / `cancelled` / `completed` / `failed`；
- `phase`：`dispatch` / `experts` / `collect` / `bundle` / `verdict` / `done`；
- `experts`：每位专家的状态、child ID、startedAt、findings；
- `waves`：总波数、已派发、已完成；
- `eta`：按专家数、单元数、文件数静态估算，第一波后按实际耗时修正；`completed/cancelled/failed` 或波次全部完成时清零；
- `units.covered`：完成时写为总单元数；
- `cancelRequested`：`/logi-cancel` 写入后阻止下一波，且 `latest` 不发布。

主编模型按 `dispatch.md` 的“进度与取消”一节，在波次和专家完成时调用 `lib/cli/progress.mjs`；`/logi-status` 读取最近一次的运行进度。`/logi-cancel` 只阻止下一波，不假装能立即杀死正在运行的子代理。

超过 `STALE_AFTER_MS = 2h` 没有 `updatedAt` 心跳的 `running/cancelling` run 视为过期：`/logi-status` 会把它标记为 `failed` + `phase: stale`，`/logi-cancel` 不再把它当作活动任务。

`lib/artifacts.js` 的 `runExtraFiles/runExtraDirs` 在最终 `verdict.mjs` 中检查 run 根目录，警告模型临时脚本/备份/调试目录；跨专家对同一测试命令报告相反的 passed/failed 时，`lib/handoffs.js` 的 `testConflicts` 写入报告警告，要求主编说明实际执行结果。

## 7. 子代理协议

### 7.1 创建

`buildChildPrompt({ expertKey, scope })` 是 child prompt 的**唯一来源**（`lib/dispatch.js`）。父代理直接把 `buildProjectDispatch` 中的 prompt 逐字传给 `subagent`：

```js
subagent({
  description: "logi-<expert>",
  prompt: "<buildChildPrompt 的完整内容>",
  // 仅当 DSH 开启子代理模型选择且项目配置了该专家路由时：
  // provider, model, reasoning_effort
})
```

`provider`/`model` 不是普通参数：只有 `modelSelectionSettings` 开启、provider 支持 `agentOptions`、且路由在允许列表内才可传；否则去掉重试，回退父会话模型。

### 7.2 专家 child 的硬约束

- 只读；不编辑源码、不提交、不删除、不嵌套 subagent。
- 只负责一个模块；只加载自己的专家 skill。
- **必须覆盖所有 `project.units`**，不能只看自己感兴趣的目录。
- 每条 finding 必须有位置、证据、触发路径、影响。
- 0.6.5 起，每条 finding 还必须有 `brief`：一句让非开发者也看得懂的自然语言简述；`title` 继续写详细的技术问题。
- 必须声明所有 section 的检查计数；计数与 findings 不一致会被判无效。
- 只写自己的 `handoff/<expert>/<expert>.json`（`/logi`）或 `handoff/<expert>.json`（单专家）；不读其他 child 的 handoff。

### 7.3 handoff

```json
{
  "schemaVersion": 2,
  "expert": "security",
  "status": "ok",
  "summary": "非空中文摘要",
  "sections": { "auth": 0, "injection": 1, "secrets": 0 },
  "units": {
    "u01": { "status": "reviewed", "filesRead": 12, "notes": "鉴权入口与过滤器已读" },
    "u02": { "status": "sampled", "filesRead": 8, "notes": "120 个 DTO，按鉴权注解抽样" },
    "u03": { "status": "skipped", "filesRead": 0, "notes": "纯静态资源" }
  },
  "tests": {
    "commands": [
      { "command": "npm test", "status": "not-run", "note": "工作区未安装依赖" }
    ]
  },
  "findings": [],
  "deferred": [],
  "notes": ""
}
```

- `units` 必须包含**所有** `project.units` id；缺失/非法 → handoff invalid。
- 0.6.6 起，每个非 `skipped` 单元必须提供 `files`（实际读过的单元内路径，不能重复、不能跨单元），至少 `min(project.minFilesPerUnit, 单元文件数)` 个，并包含该单元 `core` 的全部路径；`filesRead` 由 `files.length` 得出。
- `status` 只能是 `reviewed / sampled / skipped`；任一 `skipped` 会把 handoff 标为 `partial`，collect 不 complete。
- `sampled` 算已覆盖，但报告必须把它写成“抽样”而不是“逐行审查”。
- 每位专家还必须写自己的 Markdown 报告（>=500 字符、有 Markdown 标题、覆盖范围与发现、抽样/未验证说明）：`/logi` 为 `handoff/<expert>/<expert>.md`，单专家为 `handoff/<expert>.md`；总报告必须索引这份专家报告。
- `sections` 的每个计数必须等于该 section 的 findings 条数；未知 section、负数、缺失 section 都判无效。
- 0.6.3 起，`tests.commands` 必须逐条覆盖 `scope.testCommands`，`status` 只能是 `passed / failed / not-run`；缺失、缺命令或非法状态都判 handoff invalid。
- findings 数量超过 `scope.maxFindings`（默认 12）会被判无效，不静默截断。

### 7.4 跨专家 deferred

某个专家发现“不属于本模块、但值得转交”的问题时，写进 handoff 的 `deferred`，不要塞进 `findings`：

```json
{
  "deferred": [
    {
      "expert": "correctness",
      "file": "src/migrations/V57.sql",
      "lines": "15-18",
      "summary": "迁移绕过事件日志，且不重算 phase"
    }
  ]
}
```

- `expert` 是目标专家（可空）；`summary` 必填；`file`/`lines` 可选。
- `bundle.mjs` 把 deferred 收进 `handoffs.json` 和 `packet.md`，并加 `from` 记录来源专家。
- 主编必须把它写进 `verdict.deferred`；缺 `from` 或 `summary` 会被 contract 判无效。verdict 里不能静默丢弃。

## 8. 报告与数据契约

### 8.1 产物

```text
.logistics/runs/<runId>-master/   # 单专家为 <runId>-<expert>
  scope.json
  progress.json
  children.json
  dispatch.md
  prompts/<expert>.md
  run.jsonl
  handoff/<expert>/<expert>.json  # /logi；单专家为 handoff/<expert>.json
  handoff/<expert>/<expert>.md    # 每位专家的独立报告
  handoffs.json          # bundle：候选 finding + 专家/单元覆盖
  packet.md              # 给主编的候选材料 + 单元 × 专家矩阵
  verdict.json           # 主编裁决（机器校验 contract）
  report.md              # 核心交付物：完整项目报告
  graph.json             # 模块/问题/关系图（插件生成）
  graph.html             # 自带 SVG 的浏览器视图（插件生成）
.logistics/latest.json   # 仅默认五专家完整时更新
docs/logistics/latest.md # 仅默认五专家完整时更新
```

### 8.1.1 report.md 是核心交付物

`lib/cli/verdict.mjs` 在调用 `validateVerdict` **之前**先调用 `redactArtifacts(scope)`：用 `lib/redact.js` 的确定性规则扫描整个 run 目录下的常规文本产物（`report.md`、专家 `.json`/`.md`、`packet.md`、`handoffs.json`、`verdict.json`、`report.json`、`run.jsonl`、`scope.json`、`graph.json`、`.bak`/`.bak2`、临时 `.py`/`.sh` 等；二进制跳过）以及 `docs/logistics/latest.md`，并把 `secrets.redacted` 写入 `run.jsonl`。然后再由 `lib/report-check.js` 的 `validateReport({scope, verdict})` 做 contract 检查和残留扫描；只对 `mode === 'project'` 运行，检查：

- `scope.output.reportMarkdown` 存在，trim 后至少 1200 字符；
- 含“一句话结论 / 覆盖 / 发现或问题 / 修复 / 测试证据 / 缺口或未验证”章节；
- 0.6.4 起，`## 发现` 中每条 finding 必须带 `[severity]` 与 `[uXX]` 单元标签，且按 critical → high → medium → low 非递减排序；
- 出现全部 `scope.project.units[].id`；
- verdict 有 findings 时，报告至少出现一个 `file:line`；
- 0.6.3 起，`direct` findings 必须进入 `## 可直接修`、`plan` findings 必须进入 `## 需方案`，且正文出现 `[可直接修]` / `[需方案]` 标记；
- 0.6.3 起，`## 测试证据` 必须包含 `scope.testCommands` 中的每一条命令；
- 0.6.4 起，finding 的所属单元由报告路径映射到 `project.units`，并在报告中显式标出；
- 0.6.5 起，`## 发现` 中每条 finding 按“简述 → 详细问题 → 证据 → 影响 → 修复”展示，且必须包含该 finding 的 `brief`；
- 每位 expected 专家的 Markdown 报告存在、至少 500 字符、有 Markdown 标题（`/logi` 读 `handoff/<expert>/<expert>.md`，单专家读 `handoff/<expert>.md`，并回退旧平铺路径）；
- 总报告包含每位专家的实际报告路径索引；
- 总报告和专家报告中没有残留的疑似凭据（脱敏后仍命中则直接判不合格）。

任一项失败，`verdict.mjs` 返回非零，run 不算完成，也不会更新 latest。`report.md` 不是 `verdict.json` 的附属摘要，而是最终给用户阅读和带走的产物。

子代理必须删除自己创建的 `*.bak`、`*.bak2`、`_repro_*`、临时脚本和调试输出；`collect.mjs` 会检测 handoff 目录中的多余文件并给出警告。脱敏会覆盖这些常规文本产物，但临时文件本身仍应由模型清理。

### 8.1.2 关系图

`verdict.json` 通过 `relations` 数组声明 finding 之间的关系：`{from,to,type,reason}`，`type` 只能是 `shared-root-cause`、`same-file`、`depends-on`、`contradicts`、`related`。`lib/verdict.js` 校验 ID 必须存在于本次 findings、禁止自环、禁止重复 `from->to:type`。

`lib/graph.js` 的 `buildGraph({scope,verdict})` 生成模块节点（按 `moduleOf(file)` 从路径推导，避免模型把单元 ID 当模块）、finding 节点、`located-in` 定位边和模型关系边；`renderGraphHtml` 生成自包含 HTML + 内联 SVG：每个模块是一栏，按严重度排序的 finding 卡片放在所属模块栏内，用布局表达一对多归属；HTML 只画模块分栏，不画模块定位线或问题关系线，卡片显示 `brief`，`<title>` 提供“简述 / 详细问题 / 证据 / 影响 / 修复摘要”的悬停提示。`graph.json` 保留 `located-in` 和 `relations` 机器数据。不依赖 Graphviz/Mermaid/CDN。`writeGraph` 在 verdict 校验成功后写 `graph.json` 与 `graph.html`；图形生成失败会使本次 verdict 失败。

### 8.2 finding

```json
{
  "id": "SEC-4F2A1",
  "expert": "security",
  "module": "src/auth",
  "section": "auth",
  "severity": "high",
  "confidence": "high",
  "title": "一句话问题",
  "brief": "给非开发者看的一句话说明",
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

- `kind` 只用于报告分类：`direct` 表示可按报告直接修，`plan` 表示需要设计决策；插件不执行修复。
- 性能项永远是 `plan`。
- 没有证据的 critical/high 会被降级；`fix` 不完整会被降为 `plan`。

### 8.3 ID 与去重

- ID：`PREFIX + sha1(expert|category|file|normalizeTitle(title))` 前 5 位；不含行号，同 run 冲突自动扩到 6–8 位。
- 跨专家去重由**主编**做；`bundle.mjs` 只给 `duplicateHints`，不替主编删除。
- 机器仍保证 ID 稳定，方便报告、人工复核和主模型按 ID 修复。

### 8.4 单元覆盖

`inventory.projectUnits` 是 scope 的单元目录；`unitCoverage(inventory)` 对每个单元统计：

```text
{ id: "u01", label: "src", counts: { reviewed: 3, sampled: 1, skipped: 0, missing: 0 } }
```

`counts` 只统计 expected/valid handoff；缺失或 invalid 计入 `missing`。`collect.mjs` 打印这组数据，`packet.md` 渲染单元 × 专家表。

专家级 `coverage` 仍记录 expected / received / missing / invalid / failed / partial / complete；`optional` 只表示可追加、本次未选的专家，不算 missing。

- `complete` 只表示“本次 expected 专家都收到合法 handoff，且每个单元都未被任何专家标为 skipped”；
- 单模块也算 complete，但**不可发布 latest**；
- `latest` 只由默认五专家完整覆盖、且最终 `verdict.mjs` contract 通过的 `/logi` 更新；`aggregate.mjs` 不写 latest。进度/取消见下一节。

### 8.5 运行日志

每个 run 目录写 `run.jsonl`（每行 `{ts,event,...}`），由 `lib/runlog.js` 追加：

- `scope.created` / `scope.empty`：命令建立 run 的事实快照；
- `dispatch.queued` / `dispatch.accepted|failed`：派发消息是否成功入队；
- `collect.completed` / `bundle.completed` / `verdict.validated`：CLI 的收集、打包、contract 校验结果；

同时写 `dispatch.md` 和 `prompts/<expert>.md`，保存实际发送的父/子 prompt。日志不含密钥，但 prompt 包含文件路径与范围。日志记录“发生了什么”，不替代 handoff 中的推理内容。

## 9. 修复（插件外）

插件不提供写操作命令，也不派发 fixer。报告中的 finding 已包含位置、证据、影响与修复步骤；需要执行时，用户把 `report.md` 或指定 ID 交给主模型。

- 主模型修复受 DSH 的权限、沙箱和审批策略约束。
- 修复前应由用户确认工作区状态、分支和测试命令。
- 插件不保证修复正确性，也不替代 code review。

## 10. 只读与限制

- 审查 child 有写工具，但 prompt 要求只读；没有独立只读文件系统隔离。插件没有写操作命令，但这不等于子代理在能力上不能写。
- 审查阶段不改变工作区；源码在审查期间变化会让证据过期，当前没有硬性门禁，需要用户自行判断报告是否仍然适用。
- 一个专家覆盖所有单元意味着大型项目只能做模式扫描 + 抽样；`sampled` / `skipped` 必须诚实，报告不能把它写成逐行审查。
- 静态分析不是编译器：跨仓库、运行时问题可能漏报。
- 模型裁决可能主观；机器保留原始 handoff、候选 ID、contract 错误，便于人工复核。

## 11. 扩展

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

## 12. 已知风险

1. DSH 子代理模型选择未开启时，`models` 配置会静默回退父模型。
2. Linux/macOS 没有安装 `node` 时，派发命令依赖 `process.execPath`；Desktop 内置 Node 路径可能不在 PATH。
3. 审查 child 的只读是 prompt 级；没有独立只读文件系统隔离。
4. 审查期间源码变化会使证据过期；插件没有硬性失效检查。
5. 主编可能漏掉跨专家重复或证据冲突；`packet.md` 提供 hints，但不强制。
6. `collect` 只做格式/完整性校验，不做语义质量判断。
7. 项目超过 `project.maxFiles` 或单元上限时可能截断/合并；报告必须标明 omitted 和单元标签。
8. 没有机器门禁：是否阻塞合并由人和 CI 决定。

## 13. 文件索引

- 入口：`lib/index.js`
- 命令：`lib/commands.js`
- 全项目规划：`lib/project.js`
- 范围：`lib/scope.js`
- 路径：`lib/handoff-paths.js`
- 派发：`lib/dispatch.js`
- handoff/单元覆盖：`lib/handoffs.js`
- 报告脱敏：`lib/redact.js`
- latest 发布：`lib/latest.js`
- 进度/ETA/取消：`lib/progress.js`、`lib/cli/progress.mjs`
- 运行目录临时文件：`lib/artifacts.js`
- 报告契约：`lib/report-check.js`
- 测试命令展示：`lib/test-command.js`
- 裁决：`lib/verdict.js`
- finding/ID/模块：`lib/findings.js`
- 配置：`lib/config.js`、`lib/constants.js`
- 日志：`lib/runlog.js`
- CLI：`lib/cli/collect.mjs`、`bundle.mjs`、`verdict.mjs`
- 专家 skill：`skills/logi-correctness|security|reliability|maintainability|perf/SKILL.md`
- 测试：`test/*.test.js`（107 个）
