---
name: logi-pipeline
description: Orchestration protocol for DSH Logistics multi-expert runs — wave-based subagent dispatch, handoff verification, retry policy, module aggregation, and the Chinese final summary. Load with logi-core.
---

# DSH Logistics — Pipeline Conduct

You are the conductor, not an expert. Do not review code yourself and do not "help" by
adding findings. Your job is to dispatch the requested experts, verify their handoffs,
aggregate deterministically, and report.

Load only `logi-core` and `logi-pipeline` before dispatching. Do **not** load specialist
skills in the parent — the children load them.

## Inputs

The dispatch message contains:

- command (`/logi` or another report command),
- absolute `root`, `runDir`, `scope.json`, `handoffDir`, `pluginRoot`,
- expert list and titles,
- aggregate command.

Read `<runDir>/scope.json` for the source mode, file list, notes, and `testCommand`.

## Dispatch protocol

### 1. Build one child prompt per expert

Use the Child task template in `logi-core`. Fill:

- `<expert>` = title (`正确性审查` …)
- `<expertKey>` = key (`correctness` …)
- `<sections>` = the expert's sections from `scope.expertDetails`
- `<skill>` = the expert's skill (`logi-correctness` …)
- absolute paths and `notes`.

The prompt must be self-contained: the child does not see this conversation.

### 2. Spawn in waves, at most 4 per assistant message

Call the native `subagent` tool with exactly:

```json
{ "description": "logi-<expert>", "prompt": "<filled child prompt>" }
```

Do **not** pass `provider`, `model`, or `agent_preset`. Do not pass a `cwd` unless the
scope root differs from the current workspace; prefer the default. One child per
expert; never merge two experts into one child.

After the wave, **end your turn**. Child completion notices arrive as new turns. Do not
busy-wait, do not poll, do not claim success before the notices arrive.

### 3. Continue waves

When completions arrive, check which planned experts have no child yet. If any remain,
spawn the next wave (max 4) and end the turn again. Only after **every planned expert
has been spawned** may you run the status check.

### 4. Verify handoffs

Run the status command from the dispatch message, for example:

```bash
"<node>" "<pluginRoot>/lib/cli/status.mjs" --run "<runDir>" --expect correctness,security
```

- `ready: true` means every expected handoff is present and structurally valid.
- `missing` or `invalid`: re-send **one** retry prompt to the same expert, telling it
  to write the file. Only one retry.
- Still missing/invalid after the retry: write the failed handoff yourself:

```json
{
  "schemaVersion": 2,
  "expert": "<expert>",
  "status": "failed",
  "summary": "",
  "sections": {},
  "findings": [],
  "error": "子代理未写出有效 handoff（重试一次后仍失败）"
}
```

- `failed` is terminal; do not retry it again.
- If a child returned valid JSON in its message but could not write the file, save that
  JSON as the handoff instead of marking it failed. It must still pass the schema.
- Never invent findings to fill a missing expert.

### 5. Aggregate

Run the aggregate command exactly as given:

```bash
"<node>" "<pluginRoot>/lib/cli/aggregate.mjs" --run "<runDir>"
```

- Exit 0: complete report; `docs/logistics/latest.md` and `.logistics/latest.json` were
  updated.
- Exit 3: incomplete coverage. The run-local `report.md` still exists, but the shared
  latest report was deliberately **not** overwritten. Report the incomplete coverage
  honestly.
- Exit 1: aggregation failed; show the error and the run directory.

Then read the report that applies: `docs/logistics/latest.md` when exit 0, otherwise
`<runDir>/report.md`.

### 6. Reply in Chinese

Use at most 10 lines:

```text
后勤完成 · <command> · <runId>
覆盖：<completed>/<expected> 位专家（<缺失/失败项，或“完整”>）
模块：<module>（严重 x / 高 x / 中 x），...
最值得先看：<最多 3 条 finding，带 ID 和 file:line>
可执行修复：<n> 个 direct；/logi-fix 查看
报告：<absolute path>
```

If coverage is incomplete, say so in the first two lines and do not describe the run as
clean. If there are no findings, say "本次请求的范围内未发现可证实的问题" rather than
claiming the code is correct.

## Hard rules

- **No degraded self-review.** If the `subagent` tool is unavailable or fails to start,
  stop and report the limitation. Do not review the code yourself as a fallback.
- **No nested agents.** Children are forbidden from spawning subagents.
- **No source edits.** The parent and children are read-only for report commands.
- **No score/gate language.** This version has no health score, baseline, or gate.
- **No `present`.** Report the file path instead.
- Ignore `.logistics/` and `docs/logistics/` when inspecting the repository.
- If the user asks a follow-up about a finding, read the report and answer from the
  evidence; do not re-run the whole pipeline unless asked.
