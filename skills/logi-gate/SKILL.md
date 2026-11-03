---
name: logi-gate
description: Reference for DSH Logistics scoring, baseline ratchet, and gate decisions — exit codes, fingerprinting, coverage requirements, and configuration. Load when explaining or debugging a gate result.
---

# Gate and Baseline Reference

This is the reference for `/logi-gate` and for interpreting a report. The command itself
is deterministic: it reads the latest report, compares it with the baseline, and prints
the gate result. Do not re-run specialists just to answer a gate question.

## Scoring

Health starts at 100 and subtracts the worst finding per `file + normalized title`:

| Severity | Weight |
| --- | --- |
| critical | 25 |
| high | 10 |
| medium | 4 |
| low | 1 |
| info | 0 |

`score = max(0, 100 - sum(weights))`. Grade: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.

Duplicates with the same root title/file count once, at the worst severity. This is a
coarse signal for trend and gating, not a precise quality metric — say so if the user
asks.

## Coverage

A report is **full** only when all seven passes were expected and none is missing or
failed. Single-specialist commands (`/logi-review`, `/logi-safety`, …) and partial
tiers produce `coverage.full = false`.

Consequences:

- A partial report's score is not comparable to a full baseline.
- The gate returns `warn` with exit code **3** for partial coverage; it never claims
  "pass".
- `/logi-gate accept` refuses a partial report.
- The baseline's fixed/remaining counts only include passes that were analyzed.

Do not tell the user a partial run "passed". Say it is inconclusive and recommend
`/logi-full`.

## Baseline

Baseline file: `.logistics/baseline.json` (repo root). It stores:

- `entries[]` — one per finding: `fingerprint`, pass, category, severity, title, file,
  `firstSeenAt`, `lastSeenAt`;
- the accepted score and coverage;
- timestamps.

Fingerprint: `sha1(pass | category | file | ruleId | normalized title)`. It is
deliberately **line-independent**, so moving code or rebasing does not make old debt
look new. The tradeoff: two identical findings in the same file with the same rule and
title collapse; use distinct titles if they are genuinely different issues.

Comparison marks each finding `isNew`; `fixed` means a pass that was analyzed no longer
contains a baseline fingerprint. Passes that were not analyzed are not counted as
fixed.

`/logi-gate accept`:

- requires a full-coverage, non-stale report;
- writes the current findings as the new baseline;
- records the accepted score.

Accept after you have triaged the current debt. Do not accept to make a failing gate go
away.

## Gate exit codes

| Code | Status | Meaning |
| --- | --- | --- |
| 0 | pass | No new critical (and no new high when configured); coverage full or no blocking condition |
| 1 | fail | At least one new **critical** finding |
| 2 | fail | New **high** above the configured policy, or score drop beyond `maxScoreDrop` |
| 3 | warn | Coverage is not full (partial run, missing/failed experts), or no baseline yet |

Default policy (`DEFAULT_CONFIG.gate`):

- `failOnNewHigh: false` — new high findings do not fail by default; set to `true` to
  ratchet harder.
- `maxScoreDrop: 5` — a drop larger than 5 points fails even without new critical/high.

Gate checks only **new** findings against the baseline. Existing debt does not fail the
gate; it is tracked. The first run has no baseline, so it warns (exit 3) rather than
failing.

## Configuration

`.logistics/config.json` (all optional):

```json
{
  "ignore": ["generated/**", "**/*.snap"],
  "maxFiles": 400,
  "maxFindingsPerPass": 12,
  "includeLastCommitWhenClean": true,
  "testCommand": "pnpm test",
  "gate": {
    "failOnNewHigh": false,
    "maxScoreDrop": 5
  }
}
```

Unknown keys are warned and ignored. Invalid values fall back to defaults. Ignore
patterns are gitignore-like; a pattern without `/` matches basenames anywhere.

## Staleness

A report is stale when HEAD changed or the working tree's dirty state differs from the
recorded scope. `/logi-gate accept` refuses stale baselines; a normal check prints a
warning and recommends re-running `/logi-full`.

Staleness is a heuristic: it compares HEAD and the dirty/clean flag, not file contents.
A report generated after a `git add` can therefore look stale even if the code is
identical.

## How to answer a gate question

1. Run `/logi-gate` (or the bundled `gate.mjs`) and read the exit code.
2. Explain it in one sentence: pass / blocked by new critical / blocked by new high or
   score drop / inconclusive due to coverage.
3. Name the new findings that caused a failure, with `path:line`.
4. If coverage is partial, say which passes are missing and recommend `/logi-full`.
5. If there is no baseline, explain that the first run warns; after triage,
   `/logi-gate accept` establishes the ratchet.
6. Never edit the baseline or report by hand to change the outcome.
