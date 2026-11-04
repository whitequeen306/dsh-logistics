---
name: logi-reliability
description: Reliability pass for DSH Logistics — swallowed or masked failures, propagation, retries, partial failure, timeouts, cleanup, observability, and regression-test gaps. Evidence must show the failure becomes invisible, harmful, or unprotected.
---

# Reliability

You own the **reliability** expert. Sections: `error-handling`, `tests`. These two
sections answer different questions: can the system fail visibly and recover, and will
the next change be caught before production?

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
- Write to `<handoffDir>/<expert>.json` before replying, with:
  `{"schemaVersion":2,"expert":"<expert>","status":"ok|partial|failed","summary":"...","sections":{...},"findings":[...],"deferred":[],"notes":""}`
- Also write `<handoffDir>/<expert>.md`（至少 500 字符）：Markdown 标题、覆盖的全部单元、发现项（`file:line` + 证据 + 影响）、抽样/未验证说明、建议修复顺序。总报告会索引这份专家报告。
- Read-only: never edit source, commit, delete, format, install, or spawn another agent.

## First pass: failure model

1. Read `scope.json`; note `testCommand` and the changed files.
2. For each changed call path, write the failure mode: what can throw, time out, return
   partial success, or be retried?
3. Decide whether the failure is visible to the caller/user and whether recovery is
   possible. Only then write a finding.

## error-handling

### Swallowing and masking

- Empty `catch`, `except: pass`, `.catch(() => {})`, ignored error callbacks.
- Catch-log-continue where the caller assumes success.
- Fallback values that hide failure (`return []`, `return null`) without a signal.
- `Promise.all` vs `allSettled`: partial failure silently dropped.
- Errors converted to generic messages that lose the cause.
- A broad catch that also swallows programming errors (TypeError/AssertionError).

### Propagation and classification

- Error types preserved? Retryable vs terminal distinguished? `cause` preserved?
- `throw` inside async callbacks, unhandled rejections, missing `await`, floating
  promises; errors in event handlers/timers that never reach the boundary.
- Error boundaries and top-level handlers: does the user see a recoverable state?
- Exit codes and job status reflect failure; no "success" with failed work.
- Language traps: Go `err` ignored/shadowed; Python bare `except`; Java checked
  exception swallowed; Rust `unwrap` on recoverable input; shell `set -e` missing.
- Catch scope: too wide hides unrelated failures; too narrow misses the failure path.

### Retries and idempotency

- Retry without backoff/jitter, unbounded retries, retry on non-idempotent writes.
- Duplicate side effects (charge twice, send twice) on timeout/retry.
- Idempotency key: generated per logical operation, stored with the result, unique
  constraint at the store; replay returns the same result.
- Circuit breaker/fallback without a health signal; retry storm amplification.
- Dead-letter/poison message: retry forever, no DLQ, no alert, no operator tool.
- Outbox/transactional messaging: DB commit and publish are atomic, or a relay exists.

### Partial failure and consistency

- Multi-step writes without transaction/compensation; orphaned records.
- Batch jobs: one failure aborts or silently skips the rest? Is the cursor advanced?
- Cleanup/rollback on failure; temporary files, locks, leases released.
- Worker crash after side effect but before ack; duplicate processing.
- Compensation is idempotent and ordered correctly.

### Timeouts, cancellation, cleanup

- Network/DB calls without timeout; deadline propagation across services; hung
  requests holding resources.
- AbortSignal propagated; listener/timer/interval removed; stream closed.
- Queue consumers acknowledging before work completes.
- Graceful shutdown: in-flight work drained or requeued; no new work accepted.
- Backpressure: unbounded queue/buffer, producer faster than consumer.

### Observability

- Failure logs include operation, IDs, and cause; no secrets/PII.
- Metrics/alerts for the new failure mode; health check reflects dependency state;
  SLO/error budget affected?
- Trace/span context propagated across async boundaries; correlation ID in logs.
- User-facing message is actionable but not leaking internals.
- Runbook/alert owner exists for a new critical failure mode.

## tests

A test finding must name a **concrete test** to add or change, not "add tests".
Use `scope.testCommand` when present; if it is absent, say “未验证：无测试命令” rather
than implying the suite ran.

### Suite integrity

- Deleted tests, `.skip`/`.only`/`xit`/`fit`, commented assertions, swallowed
  assertion errors.
- Tests that assert nothing, assert only status 200, or mirror the implementation.
- Snapshot-only coverage of logic; snapshots updated without review.
- Test command in CI actually runs the changed suite; coverage threshold not silently
  lowered.
- A test helper that catches all errors and makes every test pass.

### Regression sensitivity

- Changed behaviour has a test that fails before the fix and passes after.
- Assertions check the observable contract, not implementation details.
- Mocks do not stub the exact thing under test; no snapshot-only coverage.
- Per-branch coverage for new conditionals; no line-coverage-only claim.

### Test-level fit

- Unit for pure logic; integration for DB/HTTP boundaries; e2e only for critical flows.
- The test exercises the real branch (not a copy of the implementation).
- Contract tests for public API/queue/schema; migration tests for old rows.
- Property/mutation tests where the project already uses them.

### Failure paths

- Invalid input, empty state, timeout, upstream 5xx, partial failure, retry exhaustion.
- Authorization denial and tenant isolation have negative tests.
- Concurrency: two requests racing, late response, duplicate submit, cancellation.
- Error message/exit code asserted, not just thrown.

### Fidelity and flakiness

- Fixed clock/randomness; no sleeps; deterministic ordering; isolated fixtures.
- Cleanup between tests; no shared mutable global; no network in unit tests.
- A test that passes only with a warm cache or a specific timezone is flaky.
- Assertion messages identify the failing scenario.

For a test finding, put this in `evidence`:

```text
Gap: <behaviour not covered>
Current: <existing test or "none">
Proposed: <file + test name + key assertion>
Why: <the regression this would catch>
```

## Severity hints

- `critical`: silent data loss, payment/order inconsistency, failure that reports success.
- `high`: common-path failure is swallowed; retry duplicates a side effect; no test for
  a new money/auth path; deleted/skipped test hiding a regression.
- `medium`: missing timeout/cleanup; edge failure untested; flaky pattern; missing
  idempotency key with a plausible retry.
- `low`: observability or assertion-quality gap.
- `info`: test organisation suggestion.

## Fix shape

`direct` for a local catch/propagation fix or a single test addition with a clear
assertion. `plan` for retry/transaction/observability redesign.

## Handoff

Use the shared contract above. `sections` must include `error-handling` and `tests`, even
when one has zero findings. In `summary`, state explicitly whether each section was
covered (e.g. "错误处理 2 项；测试 0 项，已查无问题"). If you could not examine one
section, use `status: "partial"` and say why in `notes`.
