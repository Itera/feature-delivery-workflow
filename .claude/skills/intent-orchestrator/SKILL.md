---
name: intent-orchestrator
description: One tick of the intent orchestrator. Creates .task-state/state.json from the intents folder if missing, picks the next eligible intent, runs the intent-to-merge workflow on it, and reports whether the loop should continue. Use with /loop.
argument-hint: "[intents-folder]"
---

# Intent orchestrator (one tick)

The whole tick is done by a deterministic script; your job is only to run it, relay its progress and act on its last line. You never implement, test, review, merge, commit, edit the state file or pick an intent yourself.

- TICK = `/Users/peter.jezik/dev/AI-dev/doWeNeedDevloop/scripts/orchestrate-tick.sh`
- REPO = the current working directory.

## Procedure

1. Run `TICK $ARGUMENTS` in REPO, in the background (async; a run takes minutes). `$ARGUMENTS` is the intents folder; it is only needed the first time (the state file remembers it).
2. While it runs, read its output about every 30 seconds and pass on the new lines unchanged (stage results, verdicts). Do not interpret or poll anything else.
3. When it has finished, show its final report block (between the `---` lines) and its last line, which is exactly one of:
   - `LOOP: CONTINUE` -> under `/loop`, schedule the next tick immediately (shortest delay).
   - `LOOP: STOP (<reason>)` -> do not schedule another tick. Repeat the reason to the user.
   If the output has no `LOOP:` line (the script crashed), show its last 20 lines and stop with `LOOP: STOP (orchestrator script failed)`.

## What the script does (for answering questions; do not do it by hand)
Preflight (git repo, empty initial commit if needed, checks/installs `scripts/task-state.js`, creates or syncs `.task-state/state.json`), a lock so only one tick runs, `task-state.js next` selection, a dirty-tree check, then the `intent-to-merge` workflow with the log in `.task-state/logs/<id>-<attempt>.log` and a timeout (`TICK_TIMEOUT`, default 6000 s) that stops the whole run. It judges the outcome by the state file, not the engine status. After the last attempt (`MAX_ATTEMPTS`, default 3) it parks the intent: `intent-git.sh park` commits the work as WIP on `feature/<slug>` (sensitive files go to a git stash instead) and checks out the base branch.

## Human follow-up (tell the user when it applies)
- `NEEDS HUMAN (merge conflict)`: merge `feature/<slug>` manually, then `scripts/task-state.js set <id> status=completed commit=<sha>`; or fix the branch and `set <id> status=pending attempts=0` to retry.
- `NEEDS HUMAN (base branch moved)`: something other than the merge step committed to the base branch during the run. Check it, then `set <id> status=pending attempts=0`.
- Exhausted attempts: the WIP is on `feature/<slug>`; fix it or the intent, then `set <id> status=pending attempts=0`.
