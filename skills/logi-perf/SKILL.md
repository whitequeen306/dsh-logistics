---
name: logi-perf
description: Performance pass for DSH Logistics — hot-path complexity, N+1 and missing indexes, blocking I/O, re-renders, memory growth, and caching. Report only realistic, evidence-backed costs.
---

# Performance

You own the **perf** expert. Section: `performance`. This module is optional and
evidence-heavy: a real cost on a path users hit, or it is not a finding.

## Measure before claiming

For every candidate, answer:

1. **Path** — which user/system flow reaches this code, and how often?
2. **Scale** — input size, row count, request rate, or list length that makes it hurt.
3. **Cost** — extra queries, O(n²) work, bytes transferred, blocking time, memory.
4. **Evidence** — benchmark, profile, query plan, or a static bound with the input size.

If you cannot name a realistic scale, downgrade to `info` or drop it. Do not report
cold-path micro-optimisations, style-level allocation, or "this might be slow".

## Checklist

### Complexity and algorithms

- Nested loops over the same collection; repeated `find`/`filter` inside a loop.
- Sorting/regex/JSON parse inside a hot loop; unbounded recursion.
- String concatenation in a large loop; repeated deep clone.

### Database and network

- N+1 queries; missing index on a filtered/joined column; `SELECT *` on wide tables.
- Loading a full table then filtering in memory; missing pagination.
- Chatty calls inside a loop; no batching; sequential awaits that could be parallel
  (only when order does not matter).
- Missing cache on a genuinely hot, stable read; cache without invalidation.

### Blocking and runtime

- Sync file/CPU work on an event-loop path; `await` in a tight loop.
- Large payload serialization; unbounded buffer/queue; listener leak.
- Unnecessary re-render: unstable props/keys, context value recreated every render,
  expensive work in render, missing memo only where measured.

### Memory and startup

- Retaining large objects in a module-level cache; growing maps without eviction.
- Loading all modules/assets at startup; eager work that can be lazy.

## Severity hints

- `high`: hot path does O(n²) or N+1 at production scale, or blocks the event loop
  long enough to affect latency.
- `medium`: measurable waste on a common path with a bounded fix.
- `low`: cold-path inefficiency or a small constant-factor improvement.
- `info`: hypothesis that needs a profile before action.

Performance findings are always `kind: "plan"` — even a one-line index needs a
migration/verification plan. Put the expected measurement in `fix.tests`.

## Handoff

Follow `logi-core` exactly. `sections` must contain `performance`. If the run did not
include a realistic hot path or you could not measure, say so in `summary` and keep
findings at `info`/`low`. Never pad this module with speculative advice.
