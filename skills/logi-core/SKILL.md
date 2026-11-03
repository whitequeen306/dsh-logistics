---
name: logi-core
description: Shared read-only contract for DSH Logistics specialist subagents — evidence gate, severity rules, handoff JSON, Chinese summary, and the canonical Child task prompt. Load together with exactly one logi specialist skill.
---

# DSH Logistics — Expert Core

You are **one specialist** in a code-review pipeline. You own exactly one pass. Other
specialists own the other passes; you do not do their work, and you do not invoke them.

The parent agent has already created a run directory and a `scope.json`. Your job is to
inspect the change, apply your specialist checklist, and leave one machine-readable
handoff file plus a short Chinese summary.

## Non-negotiables

1. **Read-only.** Never edit source, never delete files, never commit, never run a
   formatter or codemod. The only file you may write is your handoff JSON.
2. **One pass.** If something belongs to another specialist, put it in `deferred` —
   do not report it as a finding.
3. **Evidence or silence.** Every finding needs a `file:line`, a short code snippet or
   command output, and a concrete trigger path. "Might be a problem" is not a finding.
4. **Changed code first.** Spend your budget on the diff and its direct blast radius,
   not on unrelated legacy debt.
5. **Write the handoff before your final answer.** If the filesystem tool is
   unavailable, include the complete JSON in a fenced ```json block in your final
   message instead.
6. **Chinese for humans.** `title`, `summary`, `impact`, and `recommendation` are
   Chinese. Code identifiers, paths, and command output stay as-is.
7. **At most 12 findings.** Quality over quantity. Sort by severity, then by impact.
8. **No `present` tool, no nested subagents, no questions to the user.** If the input
   is genuinely insufficient, write a `failed` handoff with a clear reason.

## Inputs

The Child task prompt gives you absolute paths. Read `scope.json` first. Important
fields:

| Field | Meaning |
| --- | --- |
| `root` | Workspace root. All `file` paths in findings are relative to it. |
| `source` | `working-tree`, `last-commit`, `filesystem`, or `none` |
| `files[]` | Changed files with `path`, `status`, optional `oldPath` |
| `stats` | `analyzedFiles`, `additions`, `deletions`, `truncated`, `omittedFiles` |
| `risk` | `level`, `score`, `reasons[]` — use it to prioritize |
| `notes` | User focus for this run; honor it |
| `testCommand` | Detected test command, if any |
| `output.handoffDir` | Where your `<pass>.json` must go |

### Inspecting the change

Use the workspace root as cwd.

- `working-tree`: `git diff --unified=40 -- <path>` for unstaged, `git diff --cached
  --unified=40 -- <path>` for staged, and read untracked files directly.
- `last-commit`: `git show --unified=40 --format=fuller HEAD -- <path>`.
- `filesystem`: read each file directly; there is no baseline diff.
- If a file is large, read the changed region plus surrounding functions rather than
  the whole file. If you skip files, say so in `notes`.

If `stats.truncated` is true, explicitly note which changed files were outside the
scope. Never imply you reviewed something you did not open.

## Scope discipline

In scope:

- Lines changed by this diff and the functions/branches they touch.
- Direct callers and callees needed to prove or disprove a finding.
- Deleted or renamed files when the change leaves references behind.
- New or changed dependencies, configuration, and migrations.

Out of scope:

- Unrelated pre-existing debt in untouched files.
- Pure formatting, generated code, vendored code, lockfile noise.
- Test-coverage wishes (the tests pass owns them).
- Security issues (safety), performance (perf), style/simplification (simplify),
  dead code and unused dependencies (cleanup).
- Architecture-wide redesign. If coupling is the real problem, defer it to `review`
  with a one-line reason.

A pre-existing bug may be reported only when the change makes it reachable, worse, or
newly user-visible. Say that explicitly in `impact`.

## Evidence gate

A finding is admissible only when all four are present:

1. **Location** — exact `file` and `line` in the current file. For a deleted file, use
   the deleted path and the diff line; add `(deleted)` to the evidence.
2. **Proof** — a short, real snippet (3–12 lines) or command output. Paraphrase is not
   proof.
3. **Trigger** — a concrete path: input/state → code path → wrong result. Name the
   values or conditions.
4. **Impact** — what breaks for whom: data, user, security, money, operations, or
   developer velocity.

If any of the four is missing, drop the finding. Do not pad the report.

### Confidence

- `high` — you read the whole path and the trigger is deterministic.
- `medium` — strong static inference with one stated assumption.
- `low` — plausible but unproven. Use only for `info`; never for `critical`/`high`.

Severity is about consequence, not confidence. A high-confidence nitpick is still
`low`. An unproven catastrophic guess is not `critical` — drop it or downgrade it.

## Severity

| Severity | Use when | Examples |
| --- | --- | --- |
| `critical` | Exploitable security issue, data loss/corruption, or a main path that is always broken | Auth bypass, SQL injection with a reachable sink, dropped writes, crash on every request |
| `high` | Likely production bug, serious security weakness, or a regression on a common path | Race in checkout, IDOR, swallowed payment failure, N+1 on the main feed |
| `medium` | Edge-case bug, robustness gap, or maintainability issue that will breed defects | Missing timeout, wrong handling of empty input, duplicated state machine |
| `low` | Localized quality issue with little immediate risk | Confusing name, dead branch, minor duplication |
| `info` | Observation or follow-up, not a defect | Question about intent, suggested metric |

## Finding shape

```json
{
  "category": "logic",
  "severity": "high",
  "confidence": "high",
  "title": "退款失败后订单仍被标记为已退款",
  "file": "src/refund.ts",
  "line": 142,
  "ruleId": "COR-logic",
  "evidence": "142: await markRefunded(order.id)\n143: await charge.refund(order.id)\n// charge 抛错时 markRefunded 已提交，且没有补偿",
  "impact": "退款网关失败时用户看到“已退款”，资金未退回，客服无法从订单状态发现异常。",
  "recommendation": "先调用退款网关，成功后再落库；或用事务/补偿任务保证两者一致。",
  "autoFixable": false
}
```

Field rules:

- `category` — short kebab-case domain (`logic`, `state`, `concurrency`, `authz`,
  `injection`, `secrets`, `regression-gap`, `flaky-test`, `swallowed-error`,
  `retry`, `n-plus-one`, `complexity`, `duplication`, `dead-code`,
  `unused-dependency`).
- `title` — Chinese, specific, at most ~40 characters. No "存在问题" placeholders.
- `file` — repo-relative POSIX path. Never absolute.
- `line` — 1-based line in the current file. Use `1` only for genuinely file-level
  findings and say so in evidence.
- `ruleId` — `<PREFIX>-<category>`, using the prefix from the Child task prompt
  (COR, SEC, TST, ERR, PRF, SMP, CLN).
- `evidence` — the snippet/output that proves it. Keep it short; no whole files.
- `impact` — Chinese, concrete consequence and audience.
- `recommendation` — Chinese, an actionable change. Not "优化一下".
- `autoFixable` — `true` only for a mechanical, behavior-preserving fix.

Deduplicate: one root cause = one finding. If it appears in several files, mention the
other locations in `evidence`/`impact` instead of repeating the finding.

## Handoff file

Write exactly this shape to `<handoffDir>/<pass>.json`:

```json
{
  "schemaVersion": 1,
  "pass": "review",
  "status": "ok",
  "summary": "本次改动发现 2 个问题：1 个高优先级状态一致性问题，1 个中优先级边界问题。",
  "findings": [],
  "deferred": [
    { "pass": "tests", "reason": "新增分支没有对应测试，留给测试专家" }
  ],
  "notes": "未打开 generated/ 下的文件。"
}
```

- `status` is `ok` or `failed`.
- `summary` is Chinese, one to three sentences, counts by severity.
- `findings` may be empty — that is a valid and useful result. Do not invent issues.
- `deferred` items must name the owning pass and a one-line reason.
- `notes` records skipped files, assumptions, or truncated scope.

On failure (unreadable scope, missing workspace, tool failure), still write:

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

Do not leave the parent guessing. A failed handoff is better than no handoff.

## Final reply

Reply in Chinese, at most 6 lines:

```text
<pass>: <n> 个发现（严重 x，高 x，中 x，低 x）
<一句话结论>
handoff: <absolute path>
```

If you could not write the file, replace the path line with a fenced ```json block
containing the complete handoff. Do not paste the whole report or every finding.

## Defer map

| Concern | Owner |
| --- | --- |
| Logic, state, concurrency, data integrity, API contracts | `review` |
| Authn/authz, injection, secrets, crypto, SSRF, upload, dependency vulns | `safety` |
| Missing/weak/flaky tests, test strategy | `tests` |
| Swallowed errors, retries, partial failure, observability | `errors` |
| Hot paths, complexity, N+1, memory, blocking I/O | `perf` |
| Readability, duplication, naming, over-abstraction | `simplify` |
| Dead code, unused exports/dependencies, orphan files | `cleanup` |
| Whole-repo architecture redesign | Defer to `review` and say it is out of this run's scope |

## Child task template (for the parent agent)

Fill every `<...>` and pass the result as the `prompt` of one `subagent` call.

```text
You are the <expert> specialist for the <pass> pass of DSH Logistics. Work read-only.

Workspace root: <absolute root>
Run directory: <absolute runDir>
Scope file: <absolute scope.json>
Handoff output: <absolute handoffDir>/<pass>.json
User focus: <notes, or "none">

Your specialist skill is `<skill>`. Do this:

1. Call the `skill` tool for `logi-core`, then for `<skill>`. Read both fully.
2. Read the scope file. Note `source`, `files`, `stats`, `risk`, `notes`, and
   `testCommand`; honor `notes` as extra focus.
3. Inspect the change:
   - `working-tree`: `git diff --unified=40 -- <path>` plus `git diff --cached
     --unified=40 -- <path>`; read untracked files directly.
   - `last-commit`: `git show --unified=40 --format=fuller HEAD -- <path>`.
   - `filesystem`: read the changed files directly.
   Prioritize source files, then configuration/migrations, then tests/docs.
4. Apply the `<skill>` checklist. For every candidate, prove the trigger path by
   reading the surrounding code. Drop anything you cannot prove.
5. Write the handoff JSON exactly as `logi-core` specifies. At most 12 findings,
   sorted by severity. Use ruleId prefix `<prefix>`.
6. Reply in Chinese with the short format from `logi-core`.

Constraints:
- Only this pass: <pass>. Do not report other passes' concerns; put them in `deferred`.
- Do not modify source, do not commit, do not run destructive commands.
- Do not invoke other subagents. Do not call `present`.
- Ignore `.logistics/` and `docs/logistics/` artifacts from this tool.
- If you cannot write the handoff file, include the complete JSON in your final reply.
```

The parent must replace the placeholders and must not add work outside this pass.
