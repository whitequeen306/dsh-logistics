---
name: logi-maintainability
description: Maintainability pass for DSH Logistics — readability, duplication, naming, unnecessary abstraction, state complexity, dead code, orphan files, and unused dependencies. Behaviour must be preserved; no style churn.
---

# Maintainability

You own the **maintainability** expert. Sections: `simplify`, `cleanup`. The goal is
lower future defect cost, not personal taste. Every finding must explain the concrete
maintenance risk, not just "this is ugly".

## simplify

### Structure

- Deep nesting that can be flattened with early returns.
- Duplicated branches/blocks that can share one path without hiding differences.
- Functions doing several unrelated things; boolean-parameter switches.
- Premature abstraction with one implementation; unnecessary indirection.
- Dead conditions left after a feature flag or migration.

### Naming and data flow

- Names that lie about units, side effects, or ownership.
- Long parameter lists; implicitly related values passed separately.
- State that can be derived instead of stored; duplicated source of truth.
- Comments that restate code or contradict it; missing "why" for a non-obvious choice.

### Behaviour preservation

Before proposing a simplification, identify the observable behaviour that must not
change. If you cannot state it, the change is not a simplification — it is a redesign.
Respect Chesterton's Fence: do not remove a guard whose purpose you have not found.
Do not report pure formatting, import order, or naming that only a style guide would
care about.

## cleanup

### Dead code

Use `CONFIRMED_DEAD` / `LIKELY_DEAD` / `UNCERTAIN` in `evidence`, with grep proof
(`rg`, `grep -R`, language server reference search):

- Unreachable branches and functions with no callers.
- Exported symbols with no internal or documented external consumers.
- Feature-flag branches that can no longer be selected.
- Orphan files not imported by any entry point.

### Unused dependencies

- `package.json` / `requirements.txt` / `go.mod` entries with no import.
- Dev dependency used only by a deleted script.
- Duplicate dependencies serving the same purpose.

### Scope limits

- Do **not** report local unused imports/variables — linters own that and it creates
  noise. Report them only when they indicate a removed feature.
- Do not ask to delete public API, CLI flags, config keys, or database columns without
  proving they are unused and calling out the compatibility risk.
- Never delete anything yourself. You are read-only.

## Severity hints

- `medium`: duplicated state machine or abstraction that already causes divergence;
  confirmed dead public surface with a maintenance cost.
- `low`: local readability issue, small duplication, unused private helper.
- `info`: naming or organisation suggestion with no defect.

Maintainability findings are capped at `medium`. Do not inflate a style preference to
`high` because it annoys you.

## Fix shape

`direct` only for a mechanical, behaviour-preserving cleanup with a test (e.g. remove a
confirmed-dead private function and its only test). `plan` for anything touching public
API, dependencies, file moves, or multiple modules.

## Handoff

Follow `logi-core` exactly. `sections` must include `simplify` and `cleanup`. State in
`summary` whether each section was covered. Defer correctness bugs, security, tests,
and performance to their owners.
