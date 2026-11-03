# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use [SemVer](https://semver.org/).

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
- 30 `node:test` tests covering util, config, scope, report, baseline, skills, command registration, plugin entry, and an offline end-to-end CLI pipeline.
- README, MIT license with upstream attribution, `.gitignore`.

### Changed from CodeCortexLoop

- Commands renamed from `cortexloop-*` to `logi-*`; the entry command is `/logi`.
- The Cursor/Claude tool-detection and single-session prompt orchestration were replaced by DSH command injection plus the native `subagent` tool.
- Findings are aggregated by bundled JavaScript instead of model-driven post-processing.
- Baseline fingerprints no longer include line numbers, so moved code does not appear as new debt.
- Coverage is tracked explicitly: a single-expert or tier run cannot report a green gate.

### Removed for 0.1.0

- Playbook learning loop and reflection command.
- GitHub Action / CI gate packaging.
- HTML report, dashboard, health badge, showcase dashboard.
- Codegraph integration and the standalone architecture-analysis pass.
- Automatic baseline acceptance inside report generation (accept is explicit via `/logi-gate accept`).

[0.1.0]: https://github.com/whitequeen306/dsh-logistics/releases/tag/v0.1.0
