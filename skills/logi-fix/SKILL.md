---
name: logi-fix
description: Safe fix protocol for DSH Logistics /logi-fix runs — selected direct findings only, strict file whitelist, per-ID verification, rollback on failure, and no commits.
---

# DSH Logistics — Fix Protocol

You are the **fixer** for a small, explicitly selected set of findings. This is the only
mode that may edit source. You still do not redesign, refactor broadly, or "improve"
anything outside the selected findings.

## Inputs

The dispatch prompt gives absolute paths to:

- `selection.json` — the report run, selected finding IDs, and `allowedFiles`.
- `report.json` — the full report (read the selected findings there).
- `fixDir` — where you write `fix.json` and, on rollback, `fix-reverted.patch`.
- workspace root, and the detected test command.

Read `selection.json` first. If it is missing or malformed, stop and report failure.

## Preconditions

Before editing:

1. Confirm every selected finding exists, has `kind: "direct"`, is not `perf`, and its
   `fix.files` are a subset of `allowedFiles`.
2. Confirm `git status --porcelain` has no tracked source changes. Generated
   `.logistics/` and `docs/logistics/` files are allowed.
3. Confirm the current `HEAD` matches `selection.reportHead` when present.
4. If any check fails, do not edit. Write a failed `fix.json` and reply.

## Per-finding procedure

Work **one ID at a time**, in the order given, unless two IDs touch the same file and
the parent explicitly merged them.

1. Read the finding's evidence and the surrounding code. Re-check that the trigger is
   still real in the current file.
2. Make the smallest behaviour-preserving change that addresses the root cause.
   - Do not reformat untouched lines.
   - Do not rename public symbols.
   - Do not add dependencies.
   - Do not change unrelated tests to make them pass.
3. Run the narrowest relevant test first, then the full `testCommand` if it is cheap.
4. If tests fail, or the change requires touching a file outside `allowedFiles`:
   - Save the current diff: `git diff > <fixDir>/fix-reverted.patch`.
   - Revert only your changes (`git checkout -- <allowed files>` and remove files you
     created).
   - Mark this ID `failed` or `partial` in `fix.json` with the reason.
   - Do not attempt a second design.
5. If tests pass, record `fixed` for this ID with the changed files and test evidence.

Do not batch multiple IDs into one untested edit. Do not commit, push, install
packages, run migrations, or call the network.

## Verification

After all IDs:

- `git diff --name-only` must be a subset of `allowedFiles` (plus files you created
  that are necessary and listed in `fix.json`). Any out-of-scope path is a failure:
  revert it and report.
- `git diff --stat` should be proportional to the findings. A huge diff means you
  over-reached; revert and mark `partial`.
- Re-read the changed regions for accidental behavior changes, debug output, and
  secrets.
- If `testCommand` is absent, mark tests as `"未验证"` — do not claim success.

## fix.json

Write `<fixDir>/fix.json`:

```json
{
  "schemaVersion": 2,
  "reportRunId": "...",
  "startedAt": "...",
  "finishedAt": "...",
  "items": [
    {
      "id": "COR-AB12C",
      "status": "fixed",
      "files": ["src/refund.ts"],
      "tests": ["npm test -- refund"],
      "notes": "网关失败分支现在保持 pending"
    }
  ],
  "outOfScope": [],
  "reverted": false
}
```

`status` is `fixed`, `partial`, or `failed`. Keep the report IDs exactly as given.
Never write `fixed` for an unverified change.

## Final reply

Reply in Chinese, at most 8 lines:

```text
修复完成：<n> 个 fixed，<n> 个 partial，<n> 个 failed
- <ID>：<files> — <test result>
未验证：<...>（仅当没有测试命令）
回滚：<...>（仅当发生）
说明：未 commit；源码改动未超出白名单。
```

If nothing was changed, say so and why. Do not paste the full diff.

## Safety rules

- No commits, no pushes, no dependency changes, no migrations, no network.
- No edits outside `allowedFiles`; if the correct fix requires it, fail the ID instead.
- No `present`, no nested subagents, no questions to the user.
- Do not delete files unless the finding explicitly calls for deleting a confirmed-dead
  file and the parent included it in the whitelist.
- Preserve user changes already present in the worktree; never `git checkout .`.
