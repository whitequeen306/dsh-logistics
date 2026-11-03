---
name: logi-reliability
description: Reliability pass for DSH Logistics — swallowed or masked failures, propagation, retries, partial failure, timeouts, cleanup, observability, and regression-test gaps. Evidence must show the failure becomes invisible, harmful, or unprotected.
---

# Reliability

You own the **reliability** expert. Sections: `error-handling`, `tests`. These two
sections answer different questions: can the system fail visibly and recover, and will
the next change be caught before production?

## error-handling

### Swallowing and masking

- Empty `catch`, `except: pass`, `.catch(() => {})`, ignored error callbacks.
- Catch-log-continue where the caller assumes success.
- Fallback values that hide failure (`return []`, `return null`) without a signal.
- `Promise.all` vs `allSettled`: partial failure silently dropped.
- Errors converted to generic messages that lose the cause.

### Propagation

- Error types preserved? Retryable vs terminal distinguished?
- `throw` inside async callbacks, unhandled rejections, missing `await`.
- Error boundaries and top-level handlers: does the user see a recoverable state?
- Exit codes and job status reflect failure; no "success" with failed work.

### Retries and idempotency

- Retry without backoff/jitter, unbounded retries, retry on non-idempotent writes.
- Duplicate side effects (charge twice, send twice) on timeout/retry.
- Circuit breaker/fallback without a health signal.

### Partial failure and consistency

- Multi-step writes without transaction/compensation; orphaned records.
- Batch jobs: one failure aborts or silently skips the rest? Is the cursor advanced?
- Cleanup/rollback on failure; temporary files and locks released.

### Timeouts, cancellation, cleanup

- Network/DB calls without timeout; hung requests holding resources.
- AbortSignal propagated; listener/timer/interval removed.
- Queue consumers acknowledging before work completes.

### Observability

- Failure logs include operation, IDs, and cause; no secrets/PII.
- Metrics/alerts for the new failure mode; health check reflects dependency state.
- User-facing message is actionable but not leaking internals.

## tests

A test finding must name a **concrete test** to add or change, not "add tests".

### Regression sensitivity

- Changed behaviour has a test that fails before the fix and passes after.
- Assertions check the observable contract, not implementation details.
- Mocks do not stub the exact thing under test; no snapshot-only coverage.

### Test-level fit

- Unit for pure logic; integration for DB/HTTP boundaries; e2e only for critical flows.
- The test exercises the real branch (not a copy of the implementation).

### Failure paths

- Invalid input, empty state, timeout, upstream 5xx, partial failure, retry exhaustion.
- Authorization denial and tenant isolation have negative tests.

### Fidelity and flakiness

- Fixed clock/randomness; no sleeps; deterministic ordering; isolated fixtures.
- Cleanup between tests; no shared mutable global; no network in unit tests.
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
  a new money/auth path.
- `medium`: missing timeout/cleanup; edge failure untested; flaky pattern.
- `low`: observability or assertion-quality gap.
- `info`: test organisation suggestion.

## Fix shape

`direct` for a local catch/propagation fix or a single test addition with a clear
assertion. `plan` for retry/transaction/observability redesign.

## Handoff

Follow `logi-core` exactly. `sections` must include `error-handling` and `tests`, even
when one has zero findings. In `summary`, state explicitly whether each section was
covered (e.g. "错误处理 2 项；测试 0 项，已查无问题"). If you could not examine one
section, use `status: "partial"` and say why in `notes`.
