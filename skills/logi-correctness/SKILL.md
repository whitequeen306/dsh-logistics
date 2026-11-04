---
name: logi-correctness
description: Correctness pass for DSH Logistics — logic, state, concurrency, data integrity, API contracts, architecture boundaries, and edge inputs. Use only for the correctness expert; evidence required.
---

# Correctness

You own the **correctness** expert. Sections: `logic`, `state`, `concurrency`,
`data-integrity`, `contracts`, `architecture`, `edge-cases`. Report only defects you
can prove from the changed code.

## Shared contract

You are one expert in a read-only DSH Logistics run. The parent created the run
directory and `scope.json`; your output is one handoff JSON plus one Markdown expert report.

- One expert only. Put another expert's issue in `deferred`, never in `findings`.
- Every finding needs `file`, `line`, a real snippet/output, a concrete trigger path,
  and `impact`. No evidence: drop it.
- `severity`: `critical` / `high` / `medium` / `low` / `info`.
  `confidence`: `high` / `medium` / `low`; low is only for `info`, never for
  `critical` / `high`.
- Inspect every section named in your Child prompt. `sections` counts must equal the
  number of findings in that section; 0 means "checked and clean". If you genuinely
  cannot inspect a section, use `status: "partial"` and explain in `notes`.
- At most 12 findings. `title`, `summary`, `impact`, and `fix.*` are Chinese; paths,
  identifiers, and command output stay as-is.
- `kind: "direct"` only for a mechanical, low-risk fix inside `fix.files`;
  otherwise `kind: "plan"`. Performance findings are always `plan`.
- Finding fields: `section`, `category`, `severity`, `confidence`, `title`, `file`,
  `line`, `evidence`, `impact`, `fix{summary,steps,files,tests}`, `kind`.
- Write to the exact JSON handoff path given in the child prompt (`/logi`: `<handoffDir>/<expert>/<expert>.json`; single-expert: `<handoffDir>/<expert>.json`) before replying, with:
  `{"schemaVersion":2,"expert":"<expert>","status":"ok|partial|failed","summary":"...","sections":{...},"findings":[...],"deferred":[],"notes":""}`
- Also write the matching Markdown report at the exact path given in the child prompt (`/logi`: `<handoffDir>/<expert>/<expert>.md`; single-expert: `<handoffDir>/<expert>.md`)（至少 500 字符）：Markdown 标题、覆盖的全部单元、发现项（`file:line` + 证据 + 影响）、抽样/未验证说明、建议修复顺序。总报告会索引这份专家报告。
- Read-only: never edit source, commit, delete, format, install, or spawn another agent.

## First pass: intent and blast radius

1. Read `scope.json` and the change. What user-visible behaviour was supposed to change?
2. List the call sites and data stores that depend on the changed code. Search, don't guess.
3. For every changed branch, write the intended input → output in one line.
4. Only then run the section checklists. If a section has no plausible trigger in this
   diff, record 0 with a one-line reason in `notes`; do not invent a finding.

## What to inspect

### logic

- Requirement fit: does each branch do what the command/PR claims, for every path?
- Control flow: missing `return`, wrong early exit, unreachable branch, inverted
  condition, wrong operator, off-by-one, wrong default.
- Error paths: does a thrown/rejected result leave the caller in the intended state?
- Deleted/renamed behaviour: all callers updated? Is the old path still reachable?
- Refactor safety: same inputs produce the same observable outputs.
- Boolean/predicate composition: De Morgan mistakes, `&&`/`||` precedence, nullable
  guard skipped in one branch.

### state

- Lifecycle: initialise → update → teardown. Any path that skips initialisation or
  leaves a stale value?
- Source of truth: two copies of the same state that can diverge; cache invalidation;
  optimistic updates without rollback.
- Persistence: partial writes, missing transaction, ordering of write + side effect,
  re-entrancy, duplicate submission.
- State machines: invalid transitions, missing cancel/timeout state, terminal state
  that can be re-entered.
- UI state: loading/error/empty transitions; stale closures; state set after unmount.

### concurrency

- Shared mutable state without a lock/atomic operation.
- Check-then-act races (read balance → write balance; check quota → insert).
- `async` loops that should be sequential/parallel; unhandled rejection; missing
  `await`; floating promises.
- Timeouts, cancellation, retries without idempotency.
- Deadlock/livelock from lock ordering or unbounded queues.
- Late responses overwriting newer state; double-submit and race between optimistic
  update and server response.

### data-integrity

- Money/decimal: floating-point arithmetic, rounding mode, currency mismatch, unit
  mismatch (cents vs yuan, ms vs s), negative/refund paths.
- Invariants: totals equal line items, balances non-negative, one active record per
  key, parent/child consistency.
- Transactions: read-modify-write spans a transaction boundary; side effect committed
  before the database write; compensation missing on partial failure.
- Idempotency: duplicate retry inserts twice; idempotency key not unique or not stored
  with the result.
- Migrations: backfill missing, old rows violate the new constraint, code deployed
  before/after the schema in the wrong order; rollback path destroys data.
- Boundary conversions: integer overflow, BigInt/Number, precision loss in JSON,
  timezone/date truncation, NaN propagation.

### contracts

- Public API/schema change without versioning or migration.
- Request/response shape mismatch; nullable field treated as non-null; optional field
  removed while callers still send it.
- Status codes, error shapes, and invariants changed silently.
- Serialization: Date/Decimal/BigInt/undefined, unknown fields, strict parsing.
- Backward compatibility: old client, old queue message, old row, old config file.
- Database: migration and code deployed in the wrong order; old rows violate the new
  constraint.

### architecture

- Layer violation: domain importing transport/UI, handler reaching into persistence,
  shared module depending on an app.
- Dependency direction: a lower-level package importing a higher-level one; cycles.
- Module boundary: a rule duplicated in two modules with no single owner; leaking
  internal types across a public boundary.
- Change amplification: one concept requires edits in many unrelated files because
  the boundary is wrong.
- API surface: exported symbol has no consumer, or a public boundary exposes an
  implementation detail.
- Only report when the changed diff introduces or worsens the boundary; pre-existing
  architecture debt is `info`/`low` at most, not a blocking finding.

### edge-cases

- Empty input, `null`/`undefined`, zero, negative, NaN, very large values.
- Unicode, whitespace, path separators, duplicate keys, trailing commas.
- First/last element, single-item list, pagination boundaries, cursor invalidation.
- Time zones, DST, leap days, clock skew, expiry boundary.
- Permission boundary: owner vs admin vs anonymous; tenant isolation.
- CLI/config: missing env var, empty string vs unset, invalid enum, default drift.

## Evidence standard

For each finding, write the trigger path:

```text
input/state → code path → wrong result
```

Include the real snippet and the line. If the trigger depends on an assumption, state
it in `impact` and use `confidence: "medium"`. Do not report style, naming, test gaps,
security, or performance — defer them to the owning expert.

Use call-site search before claiming a contract break: `rg "<symbol>"`, read the caller
and the test. "No caller found" is evidence only after you show the search.

## Severity hints

- `critical`: data loss/corruption on a normal path, auth bypass, crash on every call.
- `high`: common-path regression, wrong money/order/user state, race with real impact.
- `medium`: edge-case bug, contract drift with a plausible caller, missing validation
  that can corrupt data.
- `low`: localized logic smell with no proven wrong output.
- `info`: question about intended behaviour or architecture observation.

## Fix shape

A `direct` fix is a small, mechanical change with a test. If the repair needs a product
decision, schema migration, or touches many call sites, use `kind: "plan"` and write
the options in `fix.steps`.

## Handoff

Use the shared contract above. `sections` must include all seven keys above. Use
`deferred` for security, reliability, maintainability, and perf concerns, with a short
reason and target expert.
