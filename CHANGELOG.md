# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use [SemVer](https://semver.org/).

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
