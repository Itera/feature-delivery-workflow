---
name: intent-orchestrator
description: One tick of the intent orchestrator. Creates .task-state/state.json from the intents folder if missing, picks the next eligible intent, runs the sdlc workflow on it, and reports whether the loop should continue. Use with /loop.
argument-hint: "[intents-folder]"
---

# Intent orchestrator (one tick)

The whole tick is done by a deterministic script; your job is only to run it, relay its progress and act on its last line. You never implement, test, review, merge, commit, edit the state file or pick an intent yourself.

- TICK = `.intent-loop/scripts/orchestrate-tick.sh` in REPO (the project's own copy of the loop).
- REPO = the current working directory.

## Procedure

1. Run `TICK $ARGUMENTS` in REPO, in the background (async; a run takes minutes). `$ARGUMENTS` is the intents folder; it is only needed the first time (the state file remembers it).
2. While it runs, read its output about every 30 seconds and pass on the new lines unchanged (stage results, verdicts). Do not interpret or poll anything else.
3. When it has finished, show its final report block (between the `---` lines) and its last line, which is exactly one of:
   - `LOOP: CONTINUE` -> under `/loop`, schedule the next tick immediately (shortest delay).
   - `LOOP: STOP (<reason>)` -> do not schedule another tick. Repeat the reason to the user.
   If the output has no `LOOP:` line (the script crashed), show its last 20 lines and stop with `LOOP: STOP (orchestrator script failed)`.

## What the script does (for answering questions; do not do it by hand)
Preflight (stops unless run from the root of the project whose .intent-loop/ it is, checks/installs `.intent-loop/scripts/task-state.js`, creates or syncs `.task-state/state.json`), a lock so only one tick runs, `task-state.js next` selection, a dirty-tree check, a browser check (headless Playwright Chromium for the validator's UI probes; see below), then the `sdlc` workflow with the log in `.task-state/logs/<id>-<attempt>.log` and a timeout (`TICK_TIMEOUT`, default 6000 s) that stops the whole run. It judges the outcome by the state file, not the engine status. It hashes git hooks and git config before the run; the workflow re-checks the hash before each of its git steps and the script after the run. After the last attempt (`MAX_ATTEMPTS`, default 3), or when an agent reported an intent issue, it parks the intent: `intent-git.sh park` commits the work as WIP on `feature/<slug>` (sensitive files go to a git stash instead) and checks out the base branch.

## Human follow-up (tell the user when it applies)
- `LOOP: STOP (browser check: Chromium cannot start ...)`: this machine cannot run headless Chromium, which the validator needs for UI metrics. The tick installs Playwright and Chromium in `~/.cache/intent-orchestrator/pw` by itself, and the OS libraries too when passwordless sudo works. Otherwise run once per machine: `cd ~/.cache/intent-orchestrator/pw && sudo npx playwright install-deps chromium`. For projects without a UI, set `BROWSER_CHECK=0`. No attempt was used up.
- `NEEDS HUMAN (merge conflict)`: merge `feature/<slug>` manually, then `.intent-loop/scripts/task-state.js set <id> status=completed commit=<sha>`; or fix the branch and `set <id> status=pending attempts=0` to retry.
- `NEEDS HUMAN (base branch moved)`: something other than the merge step committed to the base branch during the run. Check it, then `set <id> status=pending attempts=0`.
- `NEEDS HUMAN (intent issue reported by <role>)`: the intent itself is contradictory, impossible or unverifiable (`feedback.<role>` quotes the problem and proposes an edit). Fix the intent file, then `set <id> status=pending attempts=0 feedback={}`. Other intents that do not depend on it keep running.
- `NEEDS HUMAN (git hooks/config changed)` (the loop stops): something in the run changed `.git/hooks`, `core.hooksPath`, `.git/info/` or git config, which can make git run arbitrary code. Inspect them (`git config --list --show-origin`), revert anything unexpected, then `set <id> status=pending attempts=0`. The work was not parked.
- Exhausted attempts: the WIP is on `feature/<slug>`; fix it or the intent, then `set <id> status=pending attempts=0`.
