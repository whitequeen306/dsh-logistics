---
name: logi-correctness
description: Correctness pass for DSH Logistics — logic, state, async/concurrency, data integrity, API contracts, and edge inputs. Use only for the correctness expert; evidence required.
---

# Correctness

You own the **correctness** expert. Sections: `logic`, `state`, `concurrency`,
`contracts`, `edge-cases`. Report only defects you can prove from the changed code.

## What to inspect

### logic

- Requirement fit: does the branch do what the command/PR claims, for every path?
- Control flow: missing `return`, wrong early exit, unreachable branch, inverted
  condition, wrong operator, off-by-one, wrong default.
- Error paths: does a thrown/rejected result leave the caller in the intended state?
- Deleted/renamed behaviour: are all callers updated? Is the old path still reachable?
- Refactor safety: same inputs produce the same observable outputs.

### state

- Lifecycle: initialise → update → teardown. Any path that skips initialisation or
  leaves a stale value?
- Source of truth: two copies of the same state that can diverge; cache invalidation;
  optimistic updates without rollback.
- Persistence: partial writes, missing transaction, ordering of write + side effect,
  re-entrancy, duplicate submission.
- UI state: loading/error/empty transitions; stale closures; state set after unmount.

### concurrency

- Shared mutable state without a lock/atomic operation.
- Check-then-act races (read balance → write balance).
- `async` loops that should be sequential/parallel; unhandled rejection; missing
  `await`; floating promises.
- Timeouts, cancellation, retries without idempotency.
- Deadlock/livelock from lock ordering or unbounded queues.

### contracts

- Public API/schema change without versioning or migration.
- Request/response shape mismatch; nullable field treated as non-null.
- Status codes, error shapes, and invariants changed silently.
- Serialization: Date/Decimal/BigInt/undefined, unknown fields, strict parsing.
- Database: migration and code deployed in the wrong order; old rows violate the new
  constraint.

### edge-cases

- Empty input, `null`/`undefined`, zero, negative, NaN, very large values.
- Unicode, whitespace, path separators, duplicate keys, trailing commas.
- First/last element, single-item list, pagination boundaries.
- Time zones, DST, leap days, clock skew.
- Permission boundary: owner vs admin vs anonymous; tenant isolation.

## Evidence standard

For each finding, write the trigger path:

```text
input/state → code path → wrong result
```

Include the real snippet and the line. If the trigger depends on an assumption, state
it in `impact` and use `confidence: "medium"`. Do not report style, naming, test gaps,
security, or performance — defer them to the owning expert.

## Severity hints

- `critical`: data loss/corruption on a normal path, auth bypass, crash on every call.
- `high`: common-path regression, wrong money/order/user state, race with real impact.
- `medium`: edge-case bug, contract drift with a plausible caller, missing validation
  that can corrupt data.
- `low`: localized logic smell with no proven wrong output.
- `info`: question about intended behaviour.

## Fix shape

A `direct` fix is a small, mechanical change with a test. If the repair needs a product
decision, schema migration, or touches many call sites, use `kind: "plan"` and write
the options in `fix.steps`.

## Handoff

Follow `logi-core` exactly. `sections` must include all five keys above. Use
`deferred` for security, reliability, maintainability, and perf concerns.
