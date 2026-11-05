# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use [SemVer](https://semver.org/).

## [0.8.0] - 2026-11-05

### Added

- `/logi` 启动时写 `progress.json`，包含阶段、波次、每位专家的状态/child ID/findings、已用时间和 ETA 区间；`children.json` 记录专家到 subagent 的映射。
- 新增 `/logi-status`：查看最近一次运行的专家完成数、波次、阶段、findings 和预计剩余时间。
- 新增 `/logi-cancel`：写入取消请求，阻止下一波并禁止发布 `latest`；不删除已有产物，也不假装能立即终止正在运行的子代理。
- 派发消息增加按波次的进度检查点，要求模型每波结束报告一句进度；ETA 启动时按规模估算，第一波后按实际耗时修正。
- 测试增至 104 个，新增进度生命周期、取消阻止 latest、status/cancel 命令等用例。

### Changed

- 插件命令数从 6 个增至 8 个；默认 `/logi` 仍是五位专家。
- `verdict.mjs` 在成功校验后标记 `run.completed`；取消中的 run 不发布 latest。

### Notes

- 本次只做源码修改，尚未打包/发布；npm 最新仍是 0.7.0。

## [0.7.0] - 2026-11-05

### Changed

- `/logi` 默认专家从四位改为五位：性能（perf）纳入默认全项目审查；`OPTIONAL_EXPERTS` 为空，`/logi-perf` 仍可用于单维度重跑。
- 安全专家新增 `business-logic` 检查面（优惠/价格/配额/竞态/退款/枚举），供应链要求核对 manifest 与安装脚本；没有 lockfile 时必须写“依赖版本未能核实”。
- 健壮性专家拆成 `error-handling`、`resilience`、`observability`、`tests` 四个可审计 section，补超时、背压、降级和可观测性。
- 可维护性专家拆出独立 `coupling` section；0.7.0 起专家报告必须包含 `## 耦合度`，说明依赖方向、环、跨层/内部访问、共享持久化和变更放大。
- correctness/security 的 diff-only 措辞清理为全项目审查；架构债不再只报“本次 diff 引入/加重”的问题。
- 默认 `/logi` 描述改为“五位专家”；相关 docs、prompt 和测试同步。
- 测试增至 99 个，新增五专家默认、section 扩展和耦合度 contract 用例。

### Notes

- 本次只做源码修改，尚未打包/发布；npm 最新仍是 0.6.6。

## [0.6.7] - 2026-11-05

### Fixed

- 脱敏从固定文本扩展名改为“常规文本即扫描”：覆盖 `.bak`、`.bak2`、临时 `.py`/`.sh`、无扩展名文本；二进制文件跳过。修复备份/复现脚本残留凭据的问题。
- `latest.md` / `latest.json` 只在最终报告和 `verdict.json` 都通过 contract 后由 `verdict.mjs` 发布；`aggregate.mjs` 不再写 latest，避免旧格式或未校验报告覆盖。
- `report.json` 等后续写入的文本产物也会被脱敏；残留凭据会导致 verdict 失败。
- 子代理 prompt 要求删除自己创建的 `*.bak`、`_repro_*`、临时脚本；`collect.mjs` 发现 handoff 目录多余文件时警告。

### Changed

- 测试增至 98 个，新增全文本脱敏、latest 发布边界、aggregate 不发布 latest、临时文件警告用例。

### Notes

- 本次不打包、不发布；0.6.6 仍是 npm 最新版。

## [0.6.6] - 2026-11-05

### Added

- 每个审查单元新增 `core` 核心必读清单：构建/配置、入口、认证/安全、迁移、路由/控制器/服务链路、最大文件，最多 12 个。
- 新增 `project.minFilesPerUnit`（默认 30）；非 skipped 单元必须在 handoff 的 `units[].files` 列出实际读过的单元内路径，至少达到该最低值，并覆盖全部 `core`。
- `handoff` 校验会拒绝缺少文件清单、文件数不足、重复/跨单元路径或漏读核心文件的 handoff；`filesRead` 由 `files.length` 得出。
- `scope.project.units[].core`、`stats.coreFiles` 和总报告/专家 prompt 展示核心清单。

### Changed

- 专家 prompt 明确每条审查链路的核心文件不能跳过；`sampled` 也必须覆盖 `core` 并达到最低读取数。
- 测试增至 92 个，新增核心文件选择、最低读取、漏读核心和缺少文件清单用例。

### Notes

- 本次不打包、不发布；0.6.5 仍是 npm 最新版。

## [0.6.5] - 2026-11-05

### Added

- 每条 finding 新增 `brief`：一句面向非开发者的自然语言简述；`title` 继续保留详细技术问题。
- 报告、专家报告、handoff 和关系图统一按“简述 → 详细问题 → 证据 → 影响 → 修复”展示；关系图卡片显示简述，悬停显示详细问题、证据、影响和修复摘要。
- `report-check` 对 0.6.5 运行校验五个字段标签，并要求报告包含 verdict 中每条 finding 的 `brief`。

### Changed

- handoff 的 `findings[].brief` 对 0.6.5 项目运行必填；缺失会使 handoff invalid。
- `verdict.json` 的 finding 增加 `brief`；五份专家 skill 和子代理 prompt 都要求先写简述。
- 五个专家命令的面板描述改为“只开启……专家审查……问题，具体包括：……”并逐项列出本专家的检查范围，便于用户在选择命令前判断该开哪个专家。
- 测试增至 90 个，新增简述报告契约与关系图悬停用例；本次不打包、不发布。

## [0.6.4] - 2026-11-05

### Added

- 总报告按 critical → high → medium → low 排序，每条 finding 标出所属审查单元（`[uXX]`）；`report-check` 会拒绝未按严重度排序或缺少单元标签的报告。
- `verdict.json` 新增 `relations`（`shared-root-cause` / `same-file` / `depends-on` / `contradicts` / `related`），用于声明 finding 之间的关系；插件校验 ID、禁止自环和重复边。
- 每次成功运行生成 `graph.json` 与自包含的 `graph.html`：按模块分栏、问题卡片归属所属模块，模块归属由布局直接表达；HTML 不画问题间连线，卡片悬停显示完整标题、证据、影响和修复摘要；`graph.json` 仍保留 `located-in` 与 `relations` 机器数据；不依赖 Graphviz、Mermaid 或外部 CDN。
- 命令回复显示关系图路径；`lib/graph.js` 提供 `buildGraph` / `renderGraphHtml` / `writeGraph`。

### Changed

- 报告 contract 增加严重度排序、`[uXX]` 单元标签和 `## 发现` 检查；`verdict.mjs` 在生成 graph 失败时判本次运行失败。
- 测试增至 89 个，新增关系图、关系校验、严重度排序和单元标签用例。

## [0.6.3] - 2026-11-05

### Fixed

- **机器产物凭据残留**：`redactArtifacts` 现在扫描整个 run 目录下的文本产物（`report.md`、专家 `.json`/`.md`、`packet.md`、`handoffs.json`、`verdict.json`、`run.jsonl`、`scope.json`）和 `docs/logistics/latest.md`，不再只处理 Markdown；脱敏后仍命中凭据时直接判 run 不合格。
- 命令回复和文档明确提示 `.logistics/`、`docs/logistics/` 不应提交，并建议加入项目 `.gitignore`。

### Added

- handoff 新增 `tests.commands`：逐条声明 `scope.testCommands` 的 `passed / failed / not-run`；0.6.3 项目运行缺失或漏命令会判 invalid。
- 报告 contract 新增 `## 测试证据`、`## 可直接修`、`## 需方案` 和 `[可直接修]` / `[需方案]` 标记；报告必须覆盖 verdict 中的 direct/plan ID 和全部测试命令。

### Changed

- 测试增至 84 个，新增全产物脱敏、测试证据契约和 direct/plan 报告契约用例。
- 文档与架构说明更新到 0.6.3；本次不打包、不发布。

## [0.6.2] - 2026-11-05

### Changed

- DSH 命令面板中的命令描述写得更具体：正确性、安全、健壮性、可维护性、性能分别列出实际检查维度，例如安全包含认证授权、注入、浏览器安全、上传/SSRF、密钥、加密、数据暴露和依赖供应链。
- 命令数量、参数和审查流程不变；测试保持 81 个。

## [0.6.1] - 2026-11-04

### Fixed

- **报告凭据泄漏**：新增 `lib/redact.js`，在 `verdict.mjs` 校验 contract 之前，对 `report.md`、专家报告、`packet.md` 和 `docs/logistics/latest.md` 做确定性脱敏；覆盖私钥块、云厂商/平台 token、JWT、URL 内嵌密码、Basic/Bearer 认证和 secret 赋值，保留 `process.env.*` 等占位值。
- 脱敏后由 `lib/report-check.js` 再做残留扫描；报告仍含疑似凭据时直接判不合格，避免“已脱敏”只停留在提示层。
- `run.jsonl` 新增 `secrets.redacted` 事件；`verdict.validated` 的 warning 会提示轮换真实凭据。
- 旧版 `lib/report.js` 写 `report.json`、`report.md`、`latest.md` 前也做深拷贝脱敏。

### Changed

- 测试增至 81 个，新增 `test/redact.test.js`（纯函数、文件级、报告 contract 集成）。
- 文档与架构说明更新到 0.6.1。

## [0.6.0] - 2026-11-04

### Removed

- **移除 `/logi-fix` 命令和 `logi-fix` skill**：插件不再派发独立 fixer，也不再维护 `selection.json`、修复白名单、逐条测试和失败回滚。需要修复时，把 `report.md` 或指定 finding 交给当前主模型即可；修复受 DSH 权限与审批约束。
- 命令数从 7 个减为 6 个，skill 从 6 个减为 5 个；删除 `runFix`、`buildFixDispatch` 及相关测试。
- 简化 `lib/verdict.js`，移除仅供修复选择使用的“最近完整 verdict”读取函数。

### Changed

- `kind` 仅保留报告分类语义：`direct` 表示可按报告直接修，`plan` 表示需要设计决策；插件不再执行修复。
- 审查结束仍会询问“需要我帮你开始直接修复吗？还是你拿上报告去新开一个会话施行修复？”，但这里的“修复”指主模型直接处理，不再对应插件命令。
- 测试调整为 76 个，文档和架构说明更新到 0.6.0。

## [0.5.1] - 2026-11-04

### Changed

- **运行目录带命令后缀**：`/logi` 的 run 目录为 `<runId>-master`，单专家命令为 `<runId>-<expert>`，不再只有一串时间戳和随机码。
- **`/logi` 的 handoff 按专家分目录**：`handoff/<expert>/<expert>.json` 与 `handoff/<expert>/<expert>.md`；单专家仍为 `handoff/<expert>.json|.md`。新增 `lib/handoff-paths.js` 统一路径与兼容逻辑。
- **旧 run 兼容**：0.5.0 及更早的平铺 handoff 仍可读取；新 `/logi` scope 优先读嵌套路径，读不到时回退平铺。
- 报告 contract、命令回复、prompt 和 `packet.md` 都改用实际 handoff/专家报告路径；测试增至 81 个，新增 `-master`、单专家后缀、嵌套 handoff 与旧平铺兼容用例。
- 文档更新到 0.5.1。

## [0.5.0] - 2026-11-04

### Changed

- **`report.md` 是核心交付物**：最终报告必须能独立交给用户阅读；`verdict.json` 只是机器判决和 `/logi-fix` 的输入。命令回复把报告路径标为“核心交付物”，报告 prompt 明确要求项目总览、单元 × 专家矩阵、按模块组织的问题、证据、修复顺序和覆盖缺口。
- **每位专家写独立报告**：handoff 目录新增 `handoff/<expert>.md`；总报告必须索引所有专家报告。`lib/handoffs.js` 记录 `reportPath` / `reportExists` / `reportChars`，`packet.md` 展示专家报告。
- **报告 contract 校验**：新增 `lib/report-check.js`，检查 `report.md` 存在、至少 1200 字符、关键章节、全部单元 ID、finding 的 `file:line`、每位专家报告（至少 500 字符、有标题）及总报告索引；`verdict.mjs` 在 project 模式下拒绝不达标报告。
- **`/logi-fix` 只按 ID 修复**：无参数直接报错，不再列出全部 direct 项；`--dry-run <ID...>` 与 `<ID...>` 保留。修复 prompt 与回复展示全部检测到的测试命令。
- **审查结束必问**：单专家与 `/logi` 的最终回复必须单独询问“需要我帮你开始直接修复吗？还是你拿上报告去新开一个会话施行修复？”。
- **多模块测试命令**：`detectTestCommands` 支持根目录和一级子目录的 npm/pnpm/yarn/bun、Maven、Gradle、pytest、go、cargo，最多 8 条；LianYu-PC 从原来的 `null` 变为 4 条（admin、backend Maven、backend-agent pytest、frontend npm）。`scope.testCommands` 保存多条，`scope.testCommand` 保留第一条兼容旧调用。
- 测试增至 78 个，新增报告 contract、多模块测试命令、性能报告措辞断言；0.4.x 旧运行没有专家报告时按兼容模式只校验总报告，仍可用于 `/logi-fix`；文档更新到 0.5.0。

## [0.4.0] - 2026-11-04

### Changed

- **全项目审查**：`/logi`、`/logi-correctness`、`/logi-security`、`/logi-reliability`、`/logi-maintainability`、`/logi-perf` 现在审查整个项目，不再审查工作区 diff 或最近一次提交；没有 `/logi-diff`，没有 `--diff`。`/logi-fix` 保持不变。
- 新增 `lib/project.js`：`git ls-files` 全量清单 → 源码/配置分类 → 模块切分 → 审查单元（默认 `maxFiles=2000`、`maxFilesPerUnit=120`、`maxUnits=12`）；文档、示例/夹具、静态资源、构建产物、锁文件、生成物不进入范围。
- 每个专家仍只启动一个 child，但必须覆盖**全部审查单元**，并在 handoff 的 `units` 映射中声明 `reviewed` / `sampled` / `skipped`；缺失或非法单元会被判为 invalid，任一 `skipped` 使 handoff 为 `partial`。
- `collect.mjs` 打印每个单元的覆盖率；`packet.md` 增加单元 × 专家矩阵；主编报告必须解释未覆盖/抽样单元。
- `scope.json` 新增 `mode:'project'`、`source:'project'`、`project.units`、`project.totals`；`stats.additions` 在 project 模式表示总行数。
- 文档（README、ARCHITECTURE）按 0.4.0 全项目模型重写；测试增至 74 个。

### Removed

- 旧的改动集派发 `buildSingleDispatch` / `buildPipelineDispatch`、`optionalExpertBlock`、按单元分配专家的 assignment 逻辑，以及面向用户的 diff 范围说明。

## [0.3.5] - 2026-11-04

### Added

- 运行日志：每个 run 目录写 `run.jsonl`（scope/dispatch/collect/bundle/verdict 事件）、`dispatch.md` 和 `prompts/<expert>.md`；`/logi-fix` 目录写 `fix.selection` / `fix.dispatch` 事件。日志不含密钥，用于用户自己运行后追溯“派发了什么、专家是否交付、contract 是否通过”。
- 69 个测试（新增 `test/runlog.test.js` 和命令/端到端日志断言）。

## [0.3.4] - 2026-11-04

### Fixed

- `verdict` 的覆盖现在来自真实 handoff 校验，而不是模型自填：`coverage.received` 中的每个专家都必须有合法 handoff，`coverage.complete=true` 时 handoff 必须齐全；可选的 `perf` 可以被明确纳入覆盖，不再被当成“未运行专家”。
- `verdict` 拒绝无 `evidence` 的 critical/high、critical/high 的低置信度，以及 `id` 前缀与 `expert` 不一致的 finding，降低 `/logi-fix` 被伪造 ID/证据误导的风险。
- `/logi-fix` 改用最近一份**完整且通过校验**的 verdict；较新的不完整运行不会阻塞修复旧完整报告。
- `maxFindingsPerPass` 真正生效：scope 记录上限，子提示词使用该值，超限 handoff 判为 invalid 而不是静默截断。
- 67 个测试通过（新增可选 perf、伪造覆盖、无证据/错前缀、超限 handoff、跳过较新不完整 verdict）。

## [0.3.3] - 2026-11-04

### Fixed

- `collect`/`packet` 区分“可选专家未选择”和“必需专家缺失”：单专家运行不再把 `perf` 显示成 `missing`，也不再把可选未选当成覆盖问题。
- 跨专家 `deferred` 现在会被 `bundle.mjs` 收进 `handoffs.json`/`packet.md`，并以 `{from,expert,file,lines,summary}` 写入 `verdict.deferred`；缺 `from`/`summary` 会被 contract 拒绝，避免转交项在裁决层静默丢失。
- `verdict` 摘要输出 deferred 数量；文档补充 handoff/verdict 的 deferred 契约。

## [0.3.2] - 2026-11-04

### Changed

- 按专家审计扩展五个领域的覆盖与深度：
  - correctness 增加 `data-integrity` / `architecture` section，补齐金额/单位、事务/幂等、迁移、分层边界与调用点检查。
  - security 增加 `authz` / `browser` / `uploads` section，补齐 IDOR/租户、CSRF/Cookie/CSP、上传/下载、密码存储、暴力破解与提示注入。
  - reliability 深化错误分类、DLQ/outbox/deadline、优雅关闭、测试删除/跳过、分支/并发覆盖和测试命令验证。
  - maintainability 增加耦合/可测试性/API 一致性/配置孤儿检查，以及入口枚举与工具化死代码验证。
  - perf 拆分为 `hot-path` / `data-access` / `runtime` / `frontend` / `memory-startup`，加入 A/B/C 证据阶梯、数据库/前端检查表和可测量 `fix.tests`。
- 子代理 prompt 输出 `focus` 关注面；`/logi-perf` 未覆盖时仍明确写“性能未覆盖”。
- 60 个测试通过（新增扩展 section 断言）。

## [0.3.1] - 2026-11-04

### Fixed

- handoff 缺少任一必需 `sections` 键时现在直接判为无效，不再补 0 后放行；`collect.mjs` 不会把“没写”误当成“已检查且干净”。
- `verdict.coverage.expected` 必须与本次 `scope.experts` 完全一致；空数组不再能自证 `complete=true`，`/logi-fix` 因此不会在未覆盖的 run 上执行。
- `/logi-fix` 的派发与 skill 对齐：统一读 `selection.json` / `verdict.json` / `scope.json`，`fix.json` 使用完整 `items` schema；`selection.json` 增加 `head`，修复流程可校验 HEAD 未漂移。
- 单模块派发现在先运行 `collect.mjs` 盘点，再运行 `bundle.mjs`，不再跳过收集步骤。
- 新增端到端冒烟：临时 git 仓库 + 假 DSH handler + handoff + bundle + verdict + `/logi-fix` dry-run/apply，覆盖 59 个测试。

## [0.3.0] - 2026-11-03

### Added

- 主编模型（editor）裁决流程：主会话模型读 `scope.json`、派发专家、读原始 handoff 与 `packet.md`，合并/去重/定级后写 `verdict.json` + `report.md`；机器不再生成最终报告。
- `collect.mjs`（盘点完整性）、`bundle.mjs`（候选材料 + 稳定 ID + `packet.md`）、`verdict.mjs`（contract 校验）。
- 可选的专家模型路由：`.logistics/config.json` 的 `models.<expert>` 支持 `provider`/`model`/`reasoningEffort`；DSH 未开启子代理模型选择时自动回退主会话模型。
- `/logi` 的主编可按 diff 判断是否追加 `perf`；不追加时报告明确写“性能未覆盖”。

### Changed

- `scope.json` 新增 `optionalExperts`、`models`、`verdictJson`、`packetMarkdown`、`handoffsJson`；`handoff` 保留 schemaVersion 2 的 section 计数校验。
- `/logi-fix` 改为读取最近完整 verdict，而不是机器报告；selection 记录 `verdictRunId`/`verdictPath`。
- 派发消息不再依赖 `status.mjs`/`aggregate.mjs` 作为质量门禁；旧 CLI 保留兼容，但不再在新流程中使用。
- 56 个 `node:test` 测试，新增 verdict/collect/bundle、模型路由、主编协议、单模块 latest 边界覆盖。

## [0.2.2] - 2026-11-03

### Changed

- 精简 skill 布局：从 8 个 skill 收敛为 6 个。删除 `logi-core` 与 `logi-pipeline`，把证据门槛、finding/handoff schema、只读约束和覆盖规则内联到 5 个专家 skill 中。
- 派发消息与 `buildChildPrompt` 成为唯一的编排/子代理提示词来源；父代理不再加载编排 skill，子代理只加载自己的专家 skill。
- 子代理 prompt、失败 handoff、README/ARCHITECTURE/CHANGELOG 全部改为 6-skill 说法；测试同步为 49 个。

## [0.2.1] - 2026-11-03

### Fixed

- handoff 的 `sections` 计数现在会与 findings 实际数量核对；声明数与实际数不一致、未知 section 或全零空报告都会被判为无效，不再出现“空 handoff 也算通过”。
- `docs/logistics/latest.md` / `.logistics/latest.json` 只由“默认四模块完整”运行更新；单模块或部分覆盖只写本次 run 目录，避免覆盖上一份完整报告。
- `maintainability` 的 `medium` 上限和 `perf` 的 `kind: plan` 现在由 `lib/findings.js` 强制，而不只是 skill 里的提示。
- 跨专家去重在严重度/置信度相同时按 `EXPERT_PRIORITY` 选主专家（security > correctness > reliability > maintainability > perf）。
- 子代理提示词改为 `buildChildPrompt` 单一来源；删除 `logi-core` 中重复的 Child task template，`logi-pipeline` 直接复制派发消息中的完整提示词。失败 handoff 使用 `expert` 字段，与 schema 一致。
- 50 个 `node:test` 测试，新增 section 计数、latest 发布边界、修复 `kind`/严重度约束、去重优先级、子提示词自包含与 4 反引号围栏覆盖。

## [0.2.0] - 2026-11-03

按 `MODULE-DECISION.md` 完成模块收敛。这是一次 **BREAKING** 变更：旧的 7 专家、档位命令、健康分、基线与门禁全部移除。

### Added

- 五个模块：`correctness`、`security`、`reliability`（错误处理 + 测试）、`maintainability`（简化 + 清理）、`perf`（可选）。默认只跑前四个。
- 七个命令：`/logi`、`/logi-correctness`、`/logi-security`、`/logi-reliability`、`/logi-maintainability`、`/logi-perf`、`/logi-fix`。
- 模块化中文报告：按 `src`、`packages/api`、`apps/web` 等模块分组，输出问题、证据、影响、修复步骤、涉及文件和建议测试；没有健康分。
- 稳定 finding ID：`专家前缀 + sha1(expert|category|file|归一化标题)` 的前 5 位，不含行号；跨专家同根因去重并合并 `experts`。
- `kind: direct | plan`：`direct` 表示机械、行为保持的修复；`plan` 表示需要方案确认；性能项永远为 `plan`。
- `/logi-fix`：无参列出 direct 项；`--dry-run` 只出计划；显式 ID 才执行。要求完整报告、干净工作区、HEAD 未变，单个 fixer、文件白名单、测试、失败回滚，不自动 commit。
- `lib/findings.js`：归一化、稳定 ID、跨专家去重、模块归属、排序、严重度统计。
- handoff `schemaVersion: 2`：必须包含非空 `summary` 和覆盖全部 section 的 `sections`；`partial` 不计入完整覆盖。
- 只更新完整报告的 `latest`：部分/失败/缺失/无效覆盖不会覆盖上一份完整报告。
- 42 个 `node:test` 测试，覆盖模块报告、范围、配置、命令、CLI、skill、插件注册与 `/logi-fix` 安全分支。

### Changed

- 命令名与模块 key、skill 名统一：`logi-correctness` / `logi-security` 等；不再使用 `review` / `safety` 等旧名。
- 聚合去重从“按指纹”改为“跨专家同根因合并”，避免同一问题被两个专家重复计数。
- 覆盖状态区分 `complete` 与 `full`：`/logi` 默认四模块可 `complete`，`full` 仅指五位专家全部完成。
- 报告只保留模块、严重度、覆盖、修复顺序；不再计算分数或等级。
- 配置移除 `gate`，新增 `modules` 显示名；`testCommand` 正式成为已知配置项。

### Removed

- 健康分/等级、`.logistics/baseline.json`、基线 accept/diff、`/logi-gate` 与 `lib/cli/gate.mjs`。
- `quick` / `standard` / `full` 档位命令与风险推荐档位。
- `autoFixable`、`ruleId`、`score`、`gate` 字段，以及旧的 7 专家 skills（`logi-review`、`logi-safety`、`logi-tests`、`logi-errors`、`logi-simplify`、`logi-cleanup`、`logi-gate`）。
- 父代理自审降级：没有 `subagent` 时直接停止，不伪装成专家审查。

### Fixed

- 空 summary + 空 findings 的 handoff 不再被当作有效结果。
- 未跟踪目录（如 `docs/`）在脏检查中会展开，避免 `/logi-fix` 误判工作区不干净。
- 生成物 `.logistics/`、`docs/logistics/` 不计入范围、脏检查和 staleness。
- `src/a.js` 等根级源码文件正确归入 `src` 模块，而不是 `(root)`。
- 派发命令使用绝对 Node 路径并正确引用 Windows 路径。

## [0.1.0] - 2026-11-03

Initial DSH-native release, adapted from CodeCortexLoop 2.2.0.

### Added

- DSH plugin entry (`lib/index.js`) that registers 10 skills and 12 `/logi-*` commands.
- Hybrid dispatch: `/logi`, tier commands, and single-expert commands; one command maps to one or more read-only specialist subagents.
- Deterministic preflight in `lib/scope.js`: git working-tree / last-commit / filesystem scope, ignore rules, file caps, language and sensitivity summary, test-command detection, risk score and tier recommendation.
- `logi-core` contract skill with a canonical Child task template, evidence gate, finding / handoff schemas, and a defer map for out-of-scope observations.
- Seven specialist skills: correctness, security, tests, error handling, performance, simplification, cleanup.
- `logi-pipeline` conductor protocol: wave-based subagent dispatch (max 4 per message), handoff readiness checks, one retry, explicit failed handoffs, aggregation.
- Aggregation in `lib/report.js`: normalization, fingerprint dedupe, 0–100 health score and A–F grade, markdown + JSON reports, `docs/logistics/latest.md`, and `.logistics/latest.json` pointer.
- Baseline ratchet in `lib/baseline.js` with line-independent fingerprints, accept rules, fixed / remaining buckets, and gate exit codes 0/1/2/3.
- Deterministic `/logi-gate` command and offline CLIs: `status.mjs`, `aggregate.mjs`, `gate.mjs`.
- Chinese user-facing reports and command text; English skill internals.
- Zero runtime dependencies; plain ESM; no `@deepseek-ai/*` imports so the plugin can sit next to the host's own packages.
- 31 `node:test` tests covering util, config, scope, report, baseline, skills, command registration, plugin entry, and an offline end-to-end CLI pipeline.
- README, MIT license with upstream attribution, `.gitignore`.

### Changed from CodeCortexLoop

- Commands renamed from `cortexloop-*` to `logi-*`; the entry command is `/logi`.
- The Cursor/Claude tool-detection and single-session prompt orchestration were replaced by DSH command injection plus the native `subagent` tool.
- Findings are aggregated by bundled JavaScript instead of model-driven post-processing.
- Baseline fingerprints no longer include line numbers, so moved code does not appear as new debt.
- Generated `.logistics/` and `docs/logistics/` paths are excluded from scope scans and staleness checks; untracked directories are expanded before filtering.
- CLI commands prefer the running Node executable, so dispatch works even when `node` is not on `PATH`.
- Coverage is tracked explicitly: a single-expert or tier run cannot report a green gate.

### Removed for 0.1.0

- Playbook learning loop and reflection command.
- GitHub Action / CI gate packaging.
- HTML report, dashboard, health badge, showcase dashboard.
- Codegraph integration and the standalone architecture-analysis pass.
- Automatic baseline acceptance inside report generation (accept is explicit via `/logi-gate accept`).

[0.1.0]: https://github.com/whitequeen306/dsh-logistics/releases/tag/v0.1.0
