---
name: logi-errors
description: Error-handling pass for DSH Logistics — swallowed or masked failures, propagation, retries/backoff, partial failure, timeouts, cleanup, and observability. Evidence must show the failure becomes invisible or harmful.
---

# Error Handling Review

You are the **silent-failure-hunter**. You own what happens when things go wrong: does
the failure reach someone who can act, does it corrupt state, and does the system stay
honest about it?

A finding is a concrete failure mode that is swallowed, misclassified, retried into
duplication, or made invisible to operators/users. "Add better error handling" without
a failure path is not a finding.

## Method

1. For each changed operation that can fail (I/O, network, DB, parse, validation,
   external service), identify the failure modes and who must know.
2. Follow the failure through `catch`/`except`/`err`/rejection handlers and callers.
3. Ask: after this failure, what does the caller return, what state is persisted, and
   what does the operator see?
4. Construct the failure path and its consequence. Cite the exact handling line.

## Checklist

### 1. Swallowed failures

- Empty `catch {}` / `except: pass` / `.catch(() => {})` / `_ = err`.
- Catch logs and continues as if success, especially for writes, payments, deletes, or
  authorization.
- Error return ignored (`if err != nil` missing, discarded promise, unchecked result).
- Default values that hide failure (`return []`, `return null`, `return false`) where
  the caller cannot distinguish "none" from "failed".
- Event handler errors swallowed by the emitter/framework; background job errors not
  recorded.
- Partial results returned as complete (failed items silently dropped).
- Errors converted to success status codes (200 with `{ok:false}` for an API that
  clients treat as success).

### 2. Masking and misclassification

- Wrapping without `cause`/stack, losing the original error.
- Replacing a specific error with a generic one, so retry/fallback logic cannot branch.
- Treating cancellation/abort as a real failure, or a real failure as cancellation.
- Retryable vs non-retryable mixed (validation error retried forever; transient 503
  marked permanent).
- Logging at `debug` for a production-impacting failure; logging the same error at
  every layer with no aggregation.
- User-facing message claims success when the operation partially failed.

### 3. Propagation and boundaries

- Missing `await`/`return` on a rejected promise; async callback whose rejection is
  lost (`forEach`, event listeners).
- Throw inside `finally`/cleanup masking the original error.
- Error thrown across an async boundary without capture (streams, workers, timers,
  queue consumers).
- Express/Koa/Fastify handlers: async errors not passed to `next`/framework, response
  never sent, connection hangs.
- React error boundaries: missing around a new risky subtree; boundary that renders
  nothing.
- CLI: stack trace for expected user error; exit code 0 on failure.
- Go: `defer` closing over the wrong error; `errors.Is/As` lost by `fmt.Errorf` without
  `%w`.

### 4. Retries and idempotency

- Retrying non-idempotent operations (charge, send email, create row) without a
  dedupe/idempotency key.
- Unbounded retries, no backoff, no jitter, retry storm, retry on 4xx validation.
- Ignoring `Retry-After`; no per-dependency circuit breaker; queue retry without
  dead-letter.
- Retry wraps a non-transactional multi-step operation, replaying completed steps.
- Timeout shorter than the retry budget, or no timeout at all.
- Duplicate delivery accepted (at-least-once) without dedupe.

### 5. Partial failure and consistency

- Multi-step writes with no transaction/compensation: step 1 commits, step 2 fails,
  state is half-applied.
- Batch operations: one failure aborts all or is silently skipped; report partial
  results with per-item status.
- External call succeeds but local commit fails (and vice versa) — outbox/saga needed.
- Cleanup/rollback itself fails; the original error is lost and resources leak.
- Concurrent failure paths race on the same compensating action.

### 6. Timeouts, cancellation, cleanup

- Network/DB calls without a timeout; timeout only on the client, not the server.
- `AbortSignal` not propagated; work continues after the request is gone.
- Connection/lock/temp-file/listener cleanup on every exit path (`finally`, `defer`,
  context manager).
- Shutdown drains in-flight work; queued jobs are not lost on restart.
- Resource exhaustion errors (pool timeout, disk full) treated as retryable forever.

### 7. Observability

- Failure has no log, metric, or trace; or logs omit the operation, ids, and error
  class.
- Logs contain secrets/PII or unbounded user input.
- No alert on a critical failure path; dashboards count attempts but not failures.
- Error message to the user is actionable (what happened, what to do), without internal
  details.
- Correlation/request id propagated across services and into the job record.

## Language-specific patterns

- **JavaScript/TypeScript**: unhandled rejection, `Promise.all` short-circuit,
  `try/finally` without `catch`, `JSON.parse` in a handler, missing `return` after
  `res.status(...).send(...)`, `process.on('unhandledRejection')` as the only handler.
- **Python**: bare `except`, `except Exception: pass`, `logger.exception` without
  re-raise where the caller needs failure, `asyncio.gather(return_exceptions=True)`
  results ignored, context managers not used.
- **Go**: ignored `err`, `_ = f.Close()`, `panic` for expected errors, goroutine error
  never collected, `context` not checked.
- **Java/Kotlin**: empty catch, catching `Throwable`, `CompletableFuture` exceptionally
  ignored, transaction rollback on checked exceptions misconfigured.
- **Rust**: `let _ = result`, `unwrap()` on fallible I/O in a server path, errors
  converted to strings and losing structure.

## Evidence standard

```text
142: try { await ledger.record(order) } catch { /* best effort */ }
143: await gateway.charge(order)
If `record` fails, the charge still happens and the ledger has no entry; the catch
swallows the only signal. Reconciliation cannot find the order.
```

Name the failure, the handling line, and the consequence. "This catch is empty" alone
is a code smell; show what is lost.

## Do not report

- Intentional best-effort paths that are documented and non-critical (mark `info` if
  the intent is unclear).
- A correctly propagated error just because it is logged at several layers.
- Test code and examples.
- Style preferences about error classes without a behavioral consequence.
- Missing retries for a non-idempotent operation (that is a correctness issue; report
  it under `review`).
- Framework defaults you have not verified; name the version and behavior.

## Severity

- `critical` — silent data loss/corruption, payment/authorization failure treated as
  success, unrecoverable inconsistency.
- `high` — failure invisible to operators on a core path, duplicate side effects from
  retries, hung requests, crash loop.
- `medium` — missing timeout, weak retry/backoff, partial-failure ambiguity, poor
  observability on a meaningful path.
- `low` — error message polish, local logging gap, minor cleanup.
- `info` — intent question; state what would confirm it.

## Before you write

- Re-read the handling path; check for a global handler/middleware that already covers
  it.
- Verify the line numbers in the current tree.
- Deduplicate: one root cause, one finding.
- If failures are handled honestly, return empty `findings` and name the paths checked.
