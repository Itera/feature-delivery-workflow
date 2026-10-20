---
name: intent-orchestrator
description: One tick of the intent orchestrator. Creates .task-state/state.json from the intents folder if missing, picks the next eligible intent, runs the intent-to-merge workflow on it, and reports whether the loop should continue. Use with /loop.
argument-hint: "[intents-folder]"
---

# Intent orchestrator (one tick)

You orchestrate; you never implement, test, review or merge anything yourself. The `intent-to-merge` workflow does all of that. One invocation = at most ONE workflow run for ONE intent. Repeating the invocation (via `/loop`) is what drives all intents to completion.

## Constants
- WORKFLOW = `/Users/peter.jezik/dev/AI-dev/doWeNeedDevloop/intent-to-merge.yaml`
- TOOLING = `/Users/peter.jezik/dev/AI-dev/doWeNeedDevloop/scripts/task-state.js`
- MAX_ATTEMPTS = 3
- REPO = the current working directory (absolute path). State file: `REPO/.task-state/state.json`.

## Input
`$ARGUMENTS` = the folder with the intent markdown files (absolute, or relative to REPO), e.g. `/intent-orchestrator planning/intents`. It is only needed to create the state file; once the state exists, the folder is remembered in `intents_dir` and the argument may be omitted.

## State file contract
Top level: `base_branch` (always `main`), `intents_dir`, `critical_path` (ordered intent ids). Per intent `intents.<id>`: `intent_file` (absolute, or relative to REPO), `depends_on` (ids), `status`, `attempts` (number), `branch_slug` (default = id), and `feedback` (written by the workflow's tester/reviewer/validator when they fail). `status=completed` means merged.

## Procedure

1. **Preflight.** If REPO is not a git repo, initialise it: `git init -b main`. If the repo has no commits (`git rev-parse HEAD` fails), create one so branches can be cut: `git add -A && git commit -m "Initial commit" --allow-empty`, but first make sure `.task-state/` is not staged (it is created later, so this is only a guard). If the current branch is not `main` and no commits exist, `git branch -m main`. Report what you did. If `REPO/scripts/task-state.js` does not exist, copy TOOLING there (`mkdir -p scripts && cp`); do not commit it.
   Then check `REPO/.task-state/state.json`:
   - It exists -> run `scripts/task-state.js sync` (uses `intents_dir` from the state, or `$ARGUMENTS` if given) to add intents newly present in the folder; existing entries are never changed. Show the output only if it added something. If it fails, report the error verbatim and STOP. Then continue.
   - It does not exist -> create it from the intent files. Use `$ARGUMENTS` as the intents folder; if empty, try `REPO/planning/intents`, then `REPO/intents`; if none exists, STOP and ask for the folder. Run `scripts/task-state.js init <folder>` and show its output (the intents found and their order). It parses each file's `**ID**`, `**Depends on**` and `**Complexity**` lines, orders intents by dependencies and creates all entries as `pending`. If it fails (duplicate id, unknown dependency, cycle, no intent files), STOP and report the error verbatim; do not hand-write the state file. Then continue.

2. **Select.** Run `scripts/task-state.js next 3` in REPO. It prints JSON:
   - `{"action":"done"}` -> every intent is completed. Report that and finish with `LOOP: STOP (all intents completed)`.
   - `{"action":"blocked","waiting":[...]}` -> nothing can run (dependencies not met or attempts exhausted). Print the waiting list (id + reason) as a short table and finish with `LOOP: STOP (blocked: needs human)`.
   - `{"action":"run", id, intent_file, branch_slug, base_branch, attempt, feedback}` -> continue with the steps below. Do NOT pick an intent yourself; always use what `next` returns.

3. **Safety check.** Make sure the working tree will not leak into this intent: run `git status --porcelain -- . ':(exclude).task-state' ':(exclude)scripts/task-state.js'` and `git rev-parse --abbrev-ref HEAD`. If there are uncommitted changes AND the current branch is not `feature/<branch_slug>`, STOP with `LOOP: STOP (dirty working tree on another branch: <branch>)`. Resolve `intent_file` to an absolute path (relative to REPO) and verify it exists; if not, STOP and report.

4. **Record the attempt.** `scripts/task-state.js set <id> attempts=<attempt> status=in_progress`. Leave `feedback` untouched: on a retry the workflow's implementer reads and clears it, and uses it to fix exactly the reported problems.

5. **Run the workflow** in the background with the CLI, logging to a file, so progress can be shown while it runs: `env -u GIT_CONFIG_COUNT /Users/peter.jezik/dev/AI-dev/.digital-factory/digital-factory workflow run --allow-cross-directory -w REPO --set intent_file=<abs> --set repo_path=REPO --set branch_slug=<slug> --set base_branch=<base> --set task_id=<id> --set attempt=<n> WORKFLOW > /tmp/intent-<id>-<n>.log 2>&1` (async). Do not use the MCP `workflow_execute`: it needs Claude hooks installed. Keep the `env -u GIT_CONFIG_COUNT` prefix: agent hosts such as Copilot CLI export `GIT_CONFIG_*` vars that nested agents inherit half-stripped, which breaks every git call.
   **Show progress** while waiting: about every 20 seconds run `grep -E "✓|✗|⚠" /tmp/intent-<id>-<n>.log | grep -v Phase` and `scripts/task-state.js get <id> phase`, and print ONE short line for each stage newly finished since the last check, e.g. `[INTENT-02 #1] tester done: GREEN (phase=tested)`. Include the verdicts from `scripts/task-state.js get <id> verdicts` when they change, and the failing stage plus the first line of any `feedback` as soon as a stage fails. Print nothing if nothing changed. Stop polling when the background command has finished (check its exit/notification), then continue.

6. **Judge by the state file, not by the engine status.** A workflow can end "completed" at the engine level even though the intent escalated (gates skip later tasks). After the run read `scripts/task-state.js get <id> status` and `get <id> verdicts`:
   - `status=completed` -> the intent is merged. Success.
   - anything else -> the attempt failed. Note which stage failed (verdicts) and the `feedback` keys now present. If the engine itself failed or crashed and the status is still `in_progress`, set `status=escalated` and `feedback.engine='<engine error, short>'` so the next attempt knows.

7. **Park an exhausted intent.** If the attempt failed and `attempt >= MAX_ATTEMPTS`, stop leaving its half-done work in the tree: run `git add -A -- . ':(exclude).task-state' ':(exclude)scripts/task-state.js'`, `git commit -m "WIP (unmerged, needs human): <id>"` on its feature branch (skip if nothing to commit), then `git checkout <base_branch>`. Report that the branch `feature/<branch_slug>` holds the work for manual follow-up.

8. **Report and decide.** Print one short block: intent id, attempt n/3, outcome (COMPLETED / FAILED at <stage>), key findings if failed. Then run `scripts/task-state.js next 3` once more and end with exactly one line:
   - `LOOP: CONTINUE` if it returns `action: run` (another intent or a retry is ready),
   - otherwise `LOOP: STOP (<done|blocked: needs human>)`.
   When running under `/loop`: on `CONTINUE` schedule the next tick immediately (shortest delay) and on `STOP` do not schedule another one.

## Rules
- Never write code, commit feature work, merge, or push yourself (step 7's WIP commit is the only exception).
- Only touch intent entries through `scripts/task-state.js set`, and only the keys named above.
- Never run two workflow executions at once; intents run strictly one after another.
- Do not delete branches, state, or any files (the progress log in /tmp is the only file you create).
