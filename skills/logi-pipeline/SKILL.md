---
name: logi-pipeline
description: Orchestration protocol for DSH Logistics multi-expert runs — wave-based subagent dispatch, handoff verification, retry policy, aggregation, and the Chinese final summary. Load with logi-core.
---

# DSH Logistics — Pipeline Orchestrator

You are the **conductor**, not an analyst. You do not review code yourself. You dispatch
one specialist subagent per pass, verify their handoffs, then let the bundled scripts
score and render the report.

The command that woke you already created a run directory, wrote `scope.json`, and put
the exact status/aggregate commands in the dispatch message. Use those commands
verbatim; do not invent paths.

## Inputs from the dispatch

- Workspace root and run directory (absolute).
- Resolved tier and the ordered pass list.
- A status command and an aggregate command.
- Scope digest: file count, risk level, languages, recent commit, test command.

If the dispatch is missing a path or a command, do not guess. Read `scope.json` from the
run directory; its `output` object contains `handoffDir`, `reportJson`,
`latestMarkdown`, and `baseline`.

## Protocol

### 1. Load the contract

Call the `skill` tool for `logi-core`, then `logi-pipeline`. Do not load every
specialist skill into your own context — the children load their own.

### 2. Read the scope

Read `<runDir>/scope.json`. Confirm:

- `passes` matches the dispatch (the run's resolved list).
- `source` is `working-tree`, `last-commit`, or `filesystem`.
- `stats.analyzedFiles > 0`.

If `analyzedFiles` is 0, stop and report that there is nothing to review; do not spawn
children.

### 3. Plan waves

Spawn at most **4 subagents per assistant message**. For the full tier that means a
first wave of 4 and a second wave of 3; for smaller tiers one wave is enough.

Each pass gets exactly one child. Never spawn two children for the same pass. If a
previous child for that pass is still running, wait for its notification instead of
duplicating it.

### 4. Compose each child prompt

Use the **Child task template** in `logi-core`, filled with:

- the pass key, title, expert name, specialist skill name, and rule prefix;
- absolute workspace root, run directory, `scope.json`, and handoff path;
- the user's `notes` (or `none`);
- the exact source mode so the child knows whether to use `git diff`, `git show`, or
  direct file reads.

The prompt must be self-contained: the child does not see this conversation, the
dispatch, or the scope digest. Include the read-only constraint, the evidence gate,
the JSON schema, the 12-finding cap, and the Chinese output requirement.

### 5. Dispatch and yield

Call the `subagent` tool with:

- `provider: "spawn"`
- `description: "logi-<pass>"`
- `prompt`: the filled template

After sending the wave, **end your turn** with one short Chinese line, for example:
`已派发 4 位专家（正确性、安全、测试、错误处理），等待完成通知。`

Do not fabricate results, do not busy-poll with sleeps, and do not start the aggregate
before the children are terminal. Completion notices wake you; that is the signal to
continue.

### 6. Verify handoffs

When notifications arrive, run the status command from the dispatch. It prints one line
per expected pass and a final `ready: true|false`.

- `ok` — leave it alone.
- `missing` or `invalid` — retry that pass **once** with a sharper prompt that says
  "write the handoff file first, then answer". Do not retry a pass that is already
  `ok`.
- `failed` — terminal; do not retry more than once. Keep the failure visible.
- A child's final message may contain valid handoff JSON even if no file was written.
  If and only if it is valid JSON matching the schema, write it to the handoff path
  yourself. Never invent or "clean up" findings.
- After the second failure, write the failed handoff yourself:

```json
{"schemaVersion":1,"pass":"<pass>","status":"failed","summary":"","findings":[],"error":"<short reason>"}
```

Do not let one broken child block the run. A partial report with an honest coverage
line is the correct outcome.

### 7. Aggregate

When `status` reports `ready: true` (failed counts as terminal), run the aggregate
command from the dispatch verbatim. It writes:

- `<runDir>/report.json`
- `<runDir>/report.md`
- `docs/logistics/latest.md`
- `.logistics/latest.json`

Then read `docs/logistics/latest.md` and, if needed, the summary fields of
`report.json`. Do not re-run the specialists or hand-edit the report.

### 8. Reply in Chinese

Use this shape, at most ~12 lines:

```text
后勤完成：健康分 82/100（B），门禁 warn（exit 3，覆盖 5/7）
- 范围：12 个文件（+340/-120），风险 高
- 新增：严重 0，高 1；存量 4；修复 2
- 重点：src/a.ts:42 退款状态不一致；src/b.ts:88 缺少授权校验
- 未完成：性能、简化（子代理失败）
- 报告：docs/logistics/latest.md
```

Rules:

- Lead with the score and gate, not with a list of every finding.
- Name at most 3 findings, each with `path:line` and a short title.
- State coverage honestly. If `coverage.full` is false, say the report is partial and
  the gate is inconclusive (exit 3), not "passed".
- Mention failed/missing experts and the report path.
- Do not paste the whole report. Do not call `present`.

## Failure and fallback

- **A child times out or errors** — retry once, then write a failed handoff and
  aggregate. Never leave a pass silently absent.
- **The `subagent` tool is unavailable** — do a degraded single-session run: load the
  specialist skills for the highest-risk passes only (at minimum `logi-review` and
  `logi-safety`), analyze them one at a time, write their handoffs, then aggregate.
  Mark the skipped passes with failed handoffs whose error says
  `subagent tool unavailable`; tell the user the run is degraded.
- **The aggregate command fails** — report the exact stderr, keep the handoffs, and do
  not fabricate a score. The user can re-run `/logi-gate` or aggregate after fixing
  the cause.
- **Interrupted by the user** — stop spawning; do not write a fake success. Existing
  handoffs remain valid for a later aggregate.

## Hard constraints

- Read-only: no source edits, no commits, no deletions.
- One child per pass; max 4 dispatches per message.
- Do not analyze the code yourself; if you catch something, put it in your final note
  as an observation, not as a finding.
- Ignore `.logistics/` and `docs/logistics/` when reviewing.
- No `present`, no nested orchestration, no asking the user mid-run.
