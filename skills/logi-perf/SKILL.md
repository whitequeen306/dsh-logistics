---
name: logi-perf
description: Performance pass for DSH Logistics — hot-path complexity, data-access cost, runtime blocking, frontend rendering and bundle size, memory growth, and startup. Report only realistic, evidence-backed costs.
---

# Performance

You own the **perf** expert. Sections: `hot-path`, `data-access`, `runtime`,
`frontend`, `memory-startup`. This module is optional and evidence-heavy: a real cost on
a path users hit, or it is not a finding.

## Shared contract

You are one expert in a read-only DSH Logistics run. The parent created the run
directory and `scope.json`; your only output is one handoff JSON.

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
  otherwise `kind: "plan"`. Performance findings are **always** `plan`.
- Finding fields: `section`, `category`, `severity`, `confidence`, `title`, `file`,
  `line`, `evidence`, `impact`, `fix{summary,steps,files,tests}`, `kind`.
- Write to `<handoffDir>/<expert>.json` before replying, with:
  `{"schemaVersion":2,"expert":"<expert>","status":"ok|partial|failed","summary":"...","sections":{...},"findings":[...],"deferred":[],"notes":""}`
- Read-only: never edit source, commit, delete, format, install, or spawn another agent.

## Measure before claiming

For every candidate, answer:

1. **Path** — which user/system flow reaches this code, and how often?
2. **Scale** — input size, row count, request rate, list length, or payload size that
   makes it hurt.
3. **Cost** — extra queries, O(n²) work, bytes transferred, blocking time, memory,
   re-renders, or bundle bytes.
4. **Evidence** — pick one rung of the ladder:
   - **A. Measured**: benchmark/profile/query plan before and after.
   - **B. Instrumented**: query count, `EXPLAIN`, React Profiler, bundle analyzer,
     heap snapshot.
   - **C. Static bound**: write the complexity/byte formula with the concrete `n` from
     scope; label it an estimate.
5. **Fix test** — the metric/threshold that proves the fix (`p95 < 200ms at 10k rows`,
   `queries: 3 → 1`, `bundle -120 kB`).

If you cannot name a realistic scale and at least rung C, downgrade to `info` or drop
it. Do not report cold-path micro-optimisations, style-level allocation, or "this might
be slow".

## What to inspect

### hot-path

- Nested loops over the same collection; repeated `find`/`filter` inside a loop.
- Sorting/regex/JSON parse inside a hot loop; unbounded recursion.
- String concatenation in a large loop; repeated deep clone.
- O(n²) membership checks; accidental quadratic grouping/dedupe.
- Algorithm choice: linear scan vs map/set, repeated sort, recomputing a derived value
  per item.
- Work repeated per request/render that could be hoisted, memoized, or batched.
- Only report when the path is actually hot; show the caller/route/job.

### data-access

- N+1 queries; missing index on a filtered/joined/sorted column; `SELECT *` on wide
  tables; offset pagination on a large table.
- Loading a full table then filtering in memory; missing pagination/limit; unbounded
  `findAll`.
- Query plan: sequential scan vs index scan; composite index column order; function on
  an indexed column; leading wildcard `LIKE`.
- Chatty calls inside a loop; no batching; sequential awaits that could be parallel
  (only when order does not matter).
- Connection pool exhaustion; transaction held across network calls; long-lived idle
  transaction.
- Missing cache on a genuinely hot, stable read; cache without invalidation; cache
  stampede; key cardinality blow-up.
- Serialization cost: over-fetching columns, huge JSON, repeated encode/decode.

### runtime

- Sync file/CPU/crypto work on an event-loop path; blocking DNS/HTTP; `await` in a tight
  loop; worker pool saturation.
- Large payload serialization; unbounded buffer/queue; listener/stream leak.
- Lock contention, thread pool starvation, excessive context switching.
- Unnecessary copies/allocations in a hot path; repeated regex compilation.
- Cold start: eager imports, top-level network calls, heavy SDK initialization.

### frontend

- Unnecessary re-render: unstable props/keys, context value recreated every render,
  expensive work in render, missing memo only where measured.
- List virtualization missing for large lists; rendering the whole table.
- Layout thrash, synchronous layout reads/writes, large images without dimensions.
- Bundle size: full-library import, duplicated dependency, unminified/missing tree
  shaking, source maps shipped, large polyfills.
- Waterfall requests; blocking third-party scripts; no code splitting on a heavy route.
- Use React Profiler/bundle analyzer when available; otherwise a static bundle-size
  estimate is rung C.

### memory-startup

- Retaining large objects in a module-level cache; growing maps without eviction;
  unbounded subscriber/listener lists.
- Closures capturing request-scoped data in a long-lived object; global accumulation.
- Loading all modules/assets at startup; eager work that can be lazy.
- Startup time: synchronous initialization, large config parse, sequential network
  calls, cold-start allocation.
- Heap growth under repeated requests; missing stream backpressure.

## Severity hints

- `critical`: outage-level cost on a primary path — event loop blocked for seconds,
  memory exhaustion, query that cannot complete at production scale.
- `high`: hot path does O(n²) or N+1 at production scale, or blocks the event loop
  long enough to affect latency.
- `medium`: measurable waste on a common path with a bounded fix.
- `low`: cold-path inefficiency or a small constant-factor improvement.
- `info`: hypothesis that needs a profile before action.

Performance findings are always `kind: "plan"` — even a one-line index needs a
migration/verification plan. Put the expected measurement/threshold in `fix.tests`.

## Handoff

Use the shared contract above. `sections` must contain all five keys above. If the run
did not include a realistic hot path or you could not measure, say so in `summary` and
keep findings at `info`/`low`. Never pad this module with speculative advice.
