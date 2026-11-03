# dsh-logistics 架构与执行模型切分

> 版本：0.1.0  
> 目的：把插件拆成可独立理解、可分别评审、可分别演进的层；同时回答“当前只有只读模式，是否要加直接修改模式”。
>
> 这不是把仓库拆成多个 npm 包。当前规模（约 5,000 行，含测试与 skill）用单包 + 清晰分层更合适；真正的“切分”是职责、契约和执行方法的切分。

## 1. 一句话模型

```text
确定性命令层  →  范围快照  →  模型派发消息  →  编排 skill
                                                ↓
                                      N 个专家子代理 + 专家 skill
                                                ↓
                                          handoff JSON
                                                ↓
                            确定性聚合 / 计分 / 基线 / 门禁 / 报告
```

关键点：**模型只负责“审查与编排”，不负责计算分数、合并结果和写报告；这些由零依赖 Node 脚本完成。**

## 2. 分层总览

| 层 | 主要文件 | 职责 | 是否调用模型 |
| --- | --- | --- | --- |
| 注册层 | `lib/index.js` | Cordis `apply`，加载 skill，注册 12 个命令 | 否 |
| 命令层 | `lib/commands.js` | 解析 cwd、准备 scope、注入派发消息、执行 gate | 否（只入队） |
| 范围层 | `lib/scope.js` | git/文件扫描、忽略规则、风险评级、测试命令、`scope.json` | 否 |
| 派发层 | `lib/dispatch.js` | 生成父代理可见的派发 prompt、status/aggregate 命令 | 否 |
| 编排层 | `skills/logi-pipeline/SKILL.md` | 父代理作为 conductor：分波、派发、校验、重试、聚合 | 是 |
| 专家层 | `skills/logi-*/SKILL.md` + `subagent` | 7 位专家各自完成一个 pass，写 handoff | 是 |
| 契约层 | `skills/logi-core/SKILL.md` | 证据门槛、严重度、finding/handoff schema、Child task template | 被读取 |
| 后处理层 | `lib/report.js`、`lib/baseline.js`、`lib/cli/*.mjs` | 归一化、去重、计分、基线、门禁、Markdown/JSON | 否 |
| 配置层 | `lib/config.js`、`lib/constants.js` | 默认忽略、档位、pass 元数据、gate 配置 | 否 |
| 测试层 | `test/*.test.js` | 31 个零依赖测试：单元 + 离线 CLI 端到端 | 否 |

依赖方向是单向的：

```text
index → commands → scope / config / dispatch / baseline / report
dispatch → constants
report → baseline
cli → scope / config / report / baseline
```

运行时**不 import 任何 `@deepseek-ai/*` 包**，只使用 `ctx.commands`、`ctx.skills` 和 `agent.followup` 这些原始接口，避免和宿主版本线耦合。

## 3. 执行方法分类

插件不是“一个命令做所有事”，而是五种执行方法。理解这五种方法，比理解 12 个命令更重要。

### 3.1 确定性执行（不调用模型）

代表：`/logi-gate`、`/logi-gate accept`、`lib/cli/status.mjs`、`lib/cli/aggregate.mjs`。

- 输入：已有报告、基线、当前 git 状态。
- 输出：门禁结论、退出码、基线文件。
- 特点：可重复、可测试、无 token 成本；`gate accept` 只写 `.logistics/baseline.json`，不碰源码。
- 位置：`lib/commands.js:200` `runGate`；`lib/cli/gate.mjs`。

### 3.2 单专家执行（1 个父代理 + 1 个子代理）

代表：`/logi-review`、`/logi-safety`、`/logi-tests`、`/logi-errors`、`/logi-perf`、`/logi-simplify`、`/logi-cleanup`。

- 命令 handler：`runSingle`（`lib/commands.js:110`）。
- 只创建一个 child，`mode: "single"`，报告标记为部分覆盖。
- 适合：只关心一个维度、想快速拿到一个专家的结论、或修完一个问题后复检。
- 门禁：单专家报告 `coverage.full === false`，所以 gate 默认是 `warn`（exit 3），不是 pass。

### 3.3 多专家流水线（1 个父代理 + N 个子代理）

代表：`/logi`（自动档）、`/logi-quick`、`/logi-standard`、`/logi-full`。

- 命令 handler：`runPipeline`（`lib/commands.js:60`）。
- 父代理加载 `logi-pipeline` + `logi-core`，作为 conductor，不亲自审查。
- 每位专家一个 child；每条 assistant 消息最多 4 个；分波派发，收到完成通知后继续下一波。
- 所有 child 结束后，父代理跑 `status.mjs` → 必要时重试 → 跑 `aggregate.mjs` → 读中文报告。
- 档位：
  - quick：review、safety、errors（3）
  - standard：review、safety、tests、errors、cleanup（5）
  - full：review、safety、tests、errors、perf、simplify、cleanup（7）

### 3.4 降级单会话执行

触发：当前 DSH 没有可用的 `subagent` 工具，或 provider 不可用。

- 父代理按 `logi-pipeline` 的 fallback：只做最高风险的 `review` + `safety`，串行分析，自己写 handoff。
- 其它 pass 写 `status: "failed"`，`error: "subagent tool unavailable"`。
- 报告明确标记覆盖不完整；禁止伪装成“全量通过”。

### 3.5 修复执行（当前不存在，v0.2 候选）

代表（提议）：`/logi-fix`。

- 当前所有命令对源码只读；只有运行产物、报告和基线会落盘。
- 是否要加、怎么加，见第 8 节。结论先说：**要加，但只加“单专家、显式选择、默认不提交”的修复模式，不要让 7 个专家并行改同一个工作区。**

### 3.6 执行方法对比

| 方法 | 写源码 | 子代理数 | 覆盖 | 典型命令 | 适用 |
| --- | --- | --- | --- | --- | --- |
| 确定性 gate | 否 | 0 | 依赖已有报告 | `/logi-gate` | CI/提交前判断 |
| 单专家 | 否 | 1 | 部分 | `/logi-review` | 聚焦复检 |
| 多专家 | 否 | 3/5/7 | 全量或按档 | `/logi`、`/logi-full` | 一次看全 |
| 降级单会话 | 否 | 0 | 部分 | 自动降级 | 无 subagent 环境 |
| 修复（提议） | 是，受限 | 1 | 基于已有 finding | `/logi-fix` | 明确要改代码时 |

## 4. 命令层

### 4.1 命令清单

| 命令 | 类型 | 解析出的 passes | handler |
| --- | --- | --- | --- |
| `/logi` | 自动档 | 按风险推荐 quick/standard/full | `runPipeline` |
| `/logi-quick` | 固定档 | review, safety, errors | `runPipeline` |
| `/logi-standard` | 固定档 | review, safety, tests, errors, cleanup | `runPipeline` |
| `/logi-full` | 固定档 | 全部 7 位 | `runPipeline` |
| `/logi-review` | 单专家 | review | `runSingle` |
| `/logi-safety` | 单专家 | safety | `runSingle` |
| `/logi-tests` | 单专家 | tests | `runSingle` |
| `/logi-errors` | 单专家 | errors | `runSingle` |
| `/logi-perf` | 单专家 | perf | `runSingle` |
| `/logi-simplify` | 单专家 | simplify | `runSingle` |
| `/logi-cleanup` | 单专家 | cleanup | `runSingle` |
| `/logi-gate` | 确定性 | 无 | `runGate` |

注册位置：`lib/commands.js:277` `createCommands`；注册入口：`lib/index.js:55` `apply`。

### 4.2 handler 的确定性部分

所有 pipeline/single handler 都做同样的事：

1. 从 `invocation.agent.session.header.cwd` 取工作区；失败回退 `process.cwd()`。
2. `gitRoot(cwd) ?? cwd` 作为项目根。
3. `loadConfig(root)` 读取 `.logistics/config.json`，合并默认值并收集警告。
4. `createScope(...)` 生成 `.logistics/runs/<runId>/scope.json`。
5. 若 `scope.stats.analyzedFiles === 0`，返回中文错误，不派发。
6. 生成 dispatch 文本。
7. `agent.followup({ role: "user", id: randomUUID(), content: [...], source: { kind: "user" } })`。
8. 立即返回 `{ kind: "success", text }`，告诉用户已派发、范围、专家、报告路径。

**命令不是模型调用。** DSH 先执行 handler；handler 注入的消息才会在下一轮唤醒模型。这样命令本身可测试、可失败、可立即返回。

### 4.3 输入与返回

- 所有命令 `input: { hint, attachments: false }`。
- `rawInput` 作为 `notes` 传给专家（例如“只关注支付流程”）。
- 返回只允许 `{kind:"success"|"error", text}`；不抛异常到 UI。
- 命令 handler 不调用 `present`，不写源码。

## 5. 子代理层

### 5.1 两种角色

| 角色 | 谁 | 加载的 skill | 职责 |
| --- | --- | --- | --- |
| conductor / 父代理 | 当前会话主 Agent | `logi-pipeline` + `logi-core` | 分波、派发、校验、重试、聚合、中文汇报 |
| specialist / 子代理 | `subagent`（后端由 DSH composition 决定） | `logi-core` + 一个专家 skill | 只做一个 pass，读改动，写 handoff |

专家名称（code-reviewer、security-auditor 等）目前是 **prompt 里的角色标签**，不是 DSH agent preset。所有 child 用默认工具集启动，只靠 prompt 约束“只读、不嵌套、不改源码”。这带来一个真实风险：**只读是指令级约束，不是能力级约束。** 见第 8.4 节。

### 5.2 子代理的创建方式

父代理调用原生 `subagent` 工具：

```text
subagent({
  description: "logi-<pass>",
  prompt: <用 logi-core 的 Child task template 填充的完整 prompt>
})
```

不要传 `provider`：`subagent` 的模型参数只有 `cwd`、`description`、`prompt`（以及配置允许时的 `agent_preset`）。`provider` 是 composition 层的后端选择，不是模型可传的参数；传了会触发参数校验错误，或在模型选择模式下被误认为 LLM provider。

`subagent` 返回 `{kind:"activation", subagentId}` 后，父代理**结束本轮**。child 完成后，运行时把完成消息投递给父代理；父代理再继续。父代理不 sleep、不轮询、不重复派发同一个 pass。

### 5.3 子代理 prompt 的写法

唯一模板在 `skills/logi-core/SKILL.md:223` 的 **Child task template**。父代理只做占位符替换，不自行发明结构。

必填内容：

- 角色与 pass：`<expert>`、`<pass>`、专属 skill、ruleId 前缀。
- 绝对路径：workspace root、runDir、scope.json、handoff 路径。
- 改动来源：`working-tree` / `last-commit` / `filesystem`，以及对应的检查命令。
- 只读约束、证据门槛、严重度、finding schema、handoff schema。
- 中文要求：`title`、`summary`、`impact`、`recommendation`。
- 失败时也要写 `status: "failed"` 的 handoff。

### 5.4 子代理的硬约束

来自 `lib/dispatch.js:68` 的 `CONSTRAINT_BLOCK` 和 `logi-core`：

- 只读：不改源码、不删除、不提交、不跑格式化/codemod。
- 只做一个 pass；其它领域写进 `deferred`。
- 每个 finding 必须有位置、证据、触发路径、影响；没有证据就不报。
- 最多 12 条；按严重度排序。
- 不嵌套子代理、不调用 `present`、不向用户提问。
- 必须先把 handoff 写盘，再回复。
- 人读字段中文，代码标识/路径保持原样。

### 5.5 生命周期与失败处理

```text
派发 → 结束本轮 → 完成通知 → status.mjs
                                  ├─ ok      → 等其它 child
                                  ├─ missing → 重试一次
                                  ├─ invalid → 重试一次
                                  └─ failed  → 终态，写失败 handoff
所有 pass 终态 → aggregate.mjs → report.json / report.md
```

- 缺失/非法：重试一次，prompt 更明确地要求“先写文件再回答”。
- 第二次失败：父代理写 `{"schemaVersion":1,"pass":"...","status":"failed",...}`，不阻塞整体。
- 未派发的 pass 不算 missing；只有已派发但无 handoff 才算。
- 覆盖不完整时 gate 返回 exit 3，而不是假装通过。

### 5.6 分波策略

- 每条 assistant 消息最多 4 个 subagent（DSH/模型的并发限制）。
- full 档：第一波 4 个，第二波 3 个。
- 收到完成通知后，先补齐未派发的 pass，再进入校验。
- 不重复派发同一个 pass；不因为一个 child 慢就重派。
- 子代理之间不通信；所有协调都通过父代理 + handoff 文件。

## 6. Skill 层

### 6.1 10 个 skill 的分工

| skill | 消费者 | 作用 |
| --- | --- | --- |
| `logi-core` | 父代理 + 所有 child | 共享契约：证据、严重度、schema、Child task template |
| `logi-pipeline` | 父代理 | 编排协议：分波、重试、聚合、中文汇报 |
| `logi-review` | review child | 正确性、状态、并发、数据完整性、契约、边界 |
| `logi-safety` | safety child | 认证/授权、注入、密钥、加密、上传/SSRF、依赖 |
| `logi-tests` | tests child | 回归缺口、测试层级、断言质量、失败路径、flaky |
| `logi-errors` | errors child | 吞错、传播、重试/幂等、部分失败、超时、可观测性 |
| `logi-perf` | perf child | 热路径复杂度、N+1/索引、阻塞 I/O、重渲染、内存 |
| `logi-simplify` | simplify child | 嵌套、重复、命名、抽象、状态复杂度；保持行为 |
| `logi-cleanup` | cleanup child | 死代码、未用导出/依赖、孤儿文件；grep 证明 |
| `logi-gate` | 父代理/用户 | 计分、基线、门禁、退出码的参考手册 |

### 6.2 skill 的物理格式

```text
skills/<kebab-case-name>/SKILL.md
---
name: <kebab-case>
description: <one sentence, English>
---
<content>
```

- 运行时由 `lib/index.js:16` `loadSkills` 扫描 `skills/*/SKILL.md`，用 `parseSkillFile` 解析 frontmatter，再 `ctx.skills.register(...)`。
- 名称必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`；description 不能为空。
- `source: "dsh-logistics"`，`metadata.path` 记录绝对路径。
- 注册随 Cordis 插件上下文销毁，不需要手动清理。
- skill 不执行代码；它是给模型的指令和领域知识。

### 6.3 skill 写法规范

一个好的专家 skill 应包含：

1. **边界**：只负责哪个 pass，什么问题必须 defer。
2. **输入**：先读 `scope.json`；知道 `source`、`files`、`stats`、`risk`、`notes`、`testCommand`。
3. **检查清单**：按领域分组，给出“什么算问题”的具体模式，而不是泛泛而谈。
4. **证据要求**：位置 + 代码/命令输出 + 触发路径 + 影响。
5. **严重度**：critical/high/medium/low/info 的判定标准。
6. **输出 schema**：handoff JSON 的字段和失败形态。
7. **反例/误报**：哪些看起来像问题但不应报告。
8. **语言**：人读字段中文，内部指令英文。

`logi-core` 是唯一放 schema 和 Child task template 的地方。专家 skill 不重复 schema，避免漂移。

### 6.4 新增一个专家的步骤

1. `lib/constants.js` 的 `PASS_LIST` 增加 `{key,title,skill,expert,prefix,domain,focus}`。
2. 新建 `skills/logi-<key>/SKILL.md`。
3. 单专家命令会自动生成（`createCommands` 遍历 `PASS_LIST`）。
4. 更新档位（如果该专家要进 quick/standard/full）。
5. 更新 `test/skills.test.js` 的 10 个 skill 断言、`test/commands.test.js` 的 12 个命令断言。
6. 更新 README 的命令表。

### 6.5 新增一个命令的步骤

- 如果是新 pass：按 6.4 自动获得单专家命令。
- 如果是新档位/新模式：在 `lib/commands.js` 的 `createCommands` 增加 spec，并补 handler、dispatch、测试。
- 如果是确定性命令：只写 handler，不注入模型消息，例如 `runGate`。

## 7. 联合执行方法（端到端）

以 `/logi-standard` 为例：

1. **UI 执行命令**：DSH 调用 `lib/commands.js` 的 handler；命令本身不经过模型。
2. **准备范围**：`createScope` 读 git 状态/diff/最近提交，应用 ignore，生成文件清单、风险、测试命令，写 `scope.json`。
3. **注入派发**：handler 用 `agent.followup` 把 `buildPipelineDispatch` 的文本作为 user message 放入下一轮。
4. **父代理醒来**：加载 `logi-pipeline` + `logi-core`，读 `scope.json`。
5. **分波派发**：按 `scope.passes` 生成 child prompt，调用 `subagent`；最多 4 个/消息；结束本轮。
6. **子代理审查**：每个 child 加载 `logi-core` + 自己的 skill；按 `source` 检查 diff/提交/文件；写 `handoff/<pass>.json`。
7. **完成通知**：父代理收到通知；若有未派发 pass，先派下一波；全部派发后跑 `status.mjs`。
8. **校验/重试**：missing/invalid 重试一次；仍失败写 failed handoff；failed 不重试。
9. **聚合**：`aggregate.mjs` 调 `buildReport`：归一化、去重、计分、基线比较、门禁，写 `report.json`、`report.md`、`docs/logistics/latest.md`、`.logistics/latest.json`。
10. **中文汇报**：父代理读 `latest.md`，用固定格式回复：分数、门禁、覆盖、新增严重/高、最多 3 个重点、失败专家、报告路径。
11. **后续门禁**：用户运行 `/logi-gate` 检查；`accept` 把最近一次全量报告写成基线。

产物：

```text
.logistics/runs/<runId>/scope.json
.logistics/runs/<runId>/handoff/<pass>.json
.logistics/runs/<runId>/report.json
.logistics/runs/<runId>/report.md
docs/logistics/latest.md
.logistics/latest.json
.logistics/baseline.json          # 只在 accept 时写
```

## 8. 只读模式与直接修改模式

### 8.1 当前事实

- 所有 12 个命令对**源码**只读。
- 会写盘的内容只有：run 目录、`docs/logistics/latest.md`、`.logistics/latest.json`、`baseline.json`。
- `finding.autoFixable` 字段存在，报告里会显示“可自动修复”（`lib/report.js:597`），但当前没有修复命令消费它。
- 原 CodeCortexLoop 有 **Report / Direct** 两种模式（`--mode=direct`、`directFixFloor`、`ci.autoFix`）；v0.1 只保留了 Report。Direct 是本次迁移有意暂缓的能力，不是遗漏。
- 子代理的只读是 **prompt 约束**，不是 DSH 工具权限约束。child 仍然拥有文件写入工具，理论上可以改源码；当前靠“不遵守就失败”的约定和评审纪律。

### 8.2 要不要加直接修改模式？

**建议加，但作为独立的第五种执行方法，而不是把现有专家改成可写。**

原因：

- 多专家并行改同一个工作区会冲突：两个 child 同时改同一文件、互相覆盖，且没有合并机制。
- 审查和修改是不同风险等级：审查错了只是多一条 finding；修改错了会破坏用户代码。
- 当前 handoff 是“发现”，不是“补丁”；直接让 child 改代码，会绕过 finding 的证据/优先级，难以审计。
- 用户需要的是“可控地修”，不是“让 7 个 agent 同时动手”。

### 8.3 推荐方案：`/logi-fix`（v0.2）

**原版 Direct 模式的安全语义**（建议保留）：按 `directFixFloor`（默认 High）筛选，Critical 总是修；`autoFixable: needs-confirmation` 仍需用户确认；cleanup 删除前询问；每组修复后跑测试/lint；失败回滚该组；修完重跑专家复检并给出 before/after 分数。v0.2 的变化是：**把“多个专家并行改”改成“单个 fixer 串行改”**，以降低冲突和审计难度。

**定位**：单专家、显式、串行、默认不提交的修复命令。

输入形态（建议）：

```text
/logi-fix                      # 默认 review：Critical/High 且 autoFixable: true
/logi-fix safety               # 指定专家
/logi-fix --floor medium       # 把严重度下限放宽到 Medium
/logi-fix review COR-logic-3   # 指定 finding（ruleId 或指纹前缀）
```

流程：

1. 读最近一次报告；只允许基于**完整覆盖**的报告修复（或明确警告部分覆盖）。
2. 选择 finding：默认选 **severity ≥ High 且 `autoFixable: true`** 的项（`--floor medium|low` 可放宽）；指定 ID 时允许非自动修复项，但必须显式。
3. 创建一个 fixer 子代理（不是 7 个），加载新的 `logi-fix` skill。
4. fixer 只改选中 finding 涉及的代码；不提交、不 push、不装依赖、不删除文件；每改一处跑相关测试。
5. fixer 写 `.logistics/runs/<runId>/fix.json`：修改文件、finding 对应关系、测试命令/结果、未修复原因。
6. 父代理展示 `git diff --stat` + 测试结果 + 仍需人工确认的点；**不自动 commit**。
7. 用户确认后再决定是否提交；提交是用户/主代理的显式动作，不是插件默认行为。

约束：

- 一次只修一个 pass；多 pass 修复串行执行。
- 默认只修 `autoFixable`；非自动项需要 finding ID。
- 修改前记录 `git status`/diff 基线；修改后若出现选中范围外的文件变化，停止并报警。
- 测试失败：保留改动但标记失败，不继续扩大修改。
- 不把修复结果写回 handoff（handoff 是审查证据），单独写 `fix.json`。
- 仍然不调用 `present`，不嵌套子代理。

### 8.4 只读约束的执行级加固

无论是否加 fix 模式，都建议加一层“只读守卫”：

- 派发前记录源码树的 `git status --porcelain` 和 `git diff` 摘要。
- 聚合前再次检查；如果出现 run 目录/报告之外的源码变化，拒绝聚合，报告“子代理违反了只读约束”。
- 这比完全信任 prompt 更可靠；实现成本低，且能防止未来模型行为漂移。
- 更强方案：用 DSH agent preset 限制 child 的工具集（只给读工具）。`subagent` 工具在 profile 配置了 `allowedAgentPresets` 时会暴露 `agent_preset` 参数，`startActivation` 也接受 `agentPreset`；但本插件没有随包提供只读 preset，也没有强制 profile 开启该选择，所以当前 child 默认继承父代理 preset。要落地需要：提供 `logi-readonly` preset + 在 profile 的 `tool-subagent` 配置里允许它；这是 v0.3 议题。

### 8.5 备选方案对比

| 方案 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- |
| 保持纯只读 | 最安全、最简单 | 用户要手动改 | 保留为默认 |
| `/logi-fix` 单专家 | 可控、可审计、冲突小 | 一次只修一个维度 | **推荐 v0.2** |
| 多专家并行修 | 快 | 同文件冲突、难审计 | 不做 |
| 报告后父代理串行 apply | 全局视角 | token 高、父代理上下文重 | 可作为 fix 的内部实现 |
| 每个 child 独立 worktree | 隔离好 | 合并/测试复杂，插件要管 git | v0.3 再议 |

### 8.6 对 `autoFixable` 的处理

- 要么在 v0.2 真正消费它（fix 模式默认筛选），要么暂时从 schema 删除，避免“看起来支持自动修复，实际没有”。
- 建议保留并在 `logi-core` 明确：`autoFixable: true` 仅表示“机械、保持行为、单文件可完成的修复”，不代表“无需测试”。

## 9. 数据契约

### 9.1 `scope.json`

关键字段：

- `schemaVersion`、`runId`、`command`、`mode`、`tier`、`passes`、`notes`
- `root`、`cwd`、`isGit`、`source`（`working-tree` / `last-commit` / `filesystem`）
- `git`：branch、head、headSubject、dirty、sourceDirty
- `files[]`：path、status、oldPath
- `stats`：analyzedFiles、additions、deletions、truncated、omittedFiles
- `summary`：byStatus、languages、source/test/docs/sensitive/dependency counts
- `testCommand`
- `risk`：level、score、reasons、recommendTier
- `output`：runDir、handoffDir、reportJson、reportMarkdown、latestMarkdown、baseline
- `warnings`

### 9.2 `handoff/<pass>.json`

```json
{
  "schemaVersion": 1,
  "pass": "review",
  "status": "ok",
  "summary": "中文 1-3 句",
  "findings": [],
  "deferred": [{ "pass": "tests", "reason": "..." }],
  "notes": "跳过的文件/假设"
}
```

失败：

```json
{
  "schemaVersion": 1,
  "pass": "review",
  "status": "failed",
  "summary": "",
  "findings": [],
  "error": "具体原因"
}
```

### 9.3 `report.json`

- `schemaVersion`、`runId`、`createdAt`
- `scope`（含 root/output）
- `score`：value、grade、counts、deductions
- `coverage`：expected/completed/failed/missing/valid/percent/complete/full
- `findings[]`：归一化后的 finding，含 fingerprint、isNew
- `baseline`：hasBaseline、baselineScore、new/existing/fixed 计数、scoreDrop
- `gate`：status、code、reasons、newCritical、newHigh
- `warnings[]`

### 9.4 指纹与计分

- 指纹：`sha1(pass | category | file | ruleId | normalizedTitle)`，**不含行号**；行号漂移不会把旧债当新债。
- 计分：每个去重后的 finding 按最严重级别扣分：critical 25、high 10、medium 4、low 1、info 0；`score = max(0, 100 - sum)`。
- 等级：A ≥ 90，B ≥ 80，C ≥ 70，D ≥ 60，F < 60。
- 门禁：exit 0 pass；1 新增 critical；2 新增 high 或分数下降超阈值；3 覆盖不完整（warn）。

## 10. 评审维度（给两个评审子代理）

### 10.1 工程/DSH 集成评审

- 打包与安装：`package.json`、`dsh.bundle.patch`、`cordis.patch.yml`、`files`、npm tarball、Desktop 安装路径。
- DSH API 正确性：`ctx.commands.register`、`ctx.skills.register`、`agent.followup`、`subagent` 语义、完成通知、命令返回值。
- 编排可靠性：分波、去重、重试、失败 handoff、覆盖判定、并发限制。
- 数据与后处理：scope 正确性、ignore、路径、指纹、计分、基线、gate 退出码。
- 测试：31 个测试的覆盖盲区、真实 DSH 环境未覆盖的部分。
- 安全/健壮性：只读是 prompt 级还是能力级、路径注入、git 命令、Windows、超时、异常。
- 可维护性：模块边界、重复、命名、无类型、运行时依赖。

### 10.2 产品/UX/prompt 评审

- 命令分类是否清晰；12 个命令是否过多/过少；命名是否一致。
- 中文报告是否可读；分数/门禁/覆盖是否一眼能懂。
- skill 的领域深度、误报控制、证据要求、token 成本。
- 子代理 prompt 是否自包含；失败时是否可诊断。
- 只读 vs 修复模式的产品设计；`/logi-fix` 的交互是否合理。
- 安装/首次使用/文档/市场收录准备度。
- 与 CodeCortexLoop 的差异是否合理；是否丢了关键能力。

### 10.3 评分建议

每个维度 1–10 分，给出总分（100 分制）和 P0/P1/P2 修复清单。每条意见必须引用 `file:line` 或明确产物路径；不要只说“可以更好”。

## 11. 已知风险与开放问题

1. **只读不是硬约束**：child 有写工具，prompt 可能被绕过；需要守卫或工具限制。
2. **DSH API 漂移**：直接使用原始 ctx 接口，没有类型/版本约束；升级 DSH 后要回归。
3. **完成通知语义**：不同版本/ provider 的通知可能批量到达；父代理必须幂等，不能重复派发。
4. **Windows 路径与 Node 运行时**：已用 `toPosix`、引号处理；但 Desktop 主进程是 Electron，`process.execPath` 通常不是 `node`，dispatch 会退回 PATH 上的 `node`。本机已确认 Desktop 自带 Node 在 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`；应优先解析该运行时，否则未装 Node 的用户会在 aggregate 阶段失败。
5. **token 成本**：full 档 7 个 child + 父代理编排；quick 档是默认推荐。
6. **报告可信度**：证据门槛是 prompt 约束；需要测试/审计来防止“看起来很专业但没读代码”。
7. **修复模式**：`/logi-fix` 未实现；`autoFixable` 目前是空承诺。
8. **市场收录**：npm 已发布，catalog PR 未提交；需要确认是否要做。
9. **空 handoff 可通过**：`lib/cli/status.mjs:29` 与 `lib/report.js:188` 只要求 `findings` 是数组；空 summary + 空数组会被当作 `ok`，`coverage.full` 仍为真，可能得到 100 分。`partial` 也计入 `full`（`lib/report.js:284`），medium/low 无证据仍默认 medium 并计分。需要 handoff 质量门。
10. **真实命令未点击验证**：Desktop 已热加载 10 个 skill，证明 `apply` 执行到注册阶段；但 `/logi-*` 的 UI 级执行尚未实际点击，`agent.followup` 的唤醒与命令补全仍需一次 smoke test。

## 12. 相关文件索引

- 入口：`lib/index.js`
- 命令：`lib/commands.js`
- 范围：`lib/scope.js`
- 派发：`lib/dispatch.js`
- 报告/计分/门禁：`lib/report.js`
- 基线：`lib/baseline.js`
- 配置/常量：`lib/config.js`、`lib/constants.js`
- CLI：`lib/cli/status.mjs`、`lib/cli/aggregate.mjs`、`lib/cli/gate.mjs`
- 契约：`skills/logi-core/SKILL.md`
- 编排：`skills/logi-pipeline/SKILL.md`
- 专家：`skills/logi-review|safety|tests|errors|perf|simplify|cleanup/SKILL.md`
- 门禁参考：`skills/logi-gate/SKILL.md`
- 测试：`test/*.test.js`
