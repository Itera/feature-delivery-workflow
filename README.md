# intent-loop

The intent-to-merge dev loop for the digital-factory engine: it takes intent files one by one and, for
each, writes acceptance tests, implements, tests, reviews, validates and merges it into the base branch.

```
planning/intents/*.md + .task-state/state.json        (written by the intent-planner skill)
  └─ .intent-loop/scripts/tick-loop.sh                 ticks until LOOP: STOP
       └─ .intent-loop/scripts/orchestrate-tick.sh     one tick = one intent
            └─ digital-factory workflow run .intent-loop/intent-to-merge.yaml
                 branch -> write tests -> lock -> implement -> test gate -> review -> validate -> merge
```

## Files

| File | What it is |
|---|---|
| `intent-to-merge.yaml` | The workflow: agents, models, tasks and their gates; `metadata.stages` groups the tasks for the workflow dashboard |
| `prompts/` | Prompts of the agents: test-author, implementer, tester, reviewer, validator, reporter (found next to the workflow) |
| `scripts/orchestrate-tick.sh` | One tick: picks the next intent, runs the workflow on it, judges the result, prints `LOOP: CONTINUE` or `LOOP: STOP (<reason>)` |
| `scripts/tick-loop.sh` | Runs ticks until `LOOP: STOP` |
| `scripts/intent-git.sh` | The git steps (branch, snapshot, gates, merge, park) and the tamper guards, run from the committed base branch |
| `scripts/task-state.js` | Reads and writes `.task-state/state.json` |
| `scripts/intent-guard-ignore` | Paths the reviewer/validator may change while running the app |
| `package.json` | Marks the scripts as CommonJS, whatever the project uses |
| `skills/intent-orchestrator/` | Agent skill that runs one tick (`/intent-orchestrator`; in Claude Code also under `/loop`) |
| `install.sh` | Optional: does the steps below for you |

## Using it in a project

The loop runs its scripts from the commit on the base branch, so it lives inside each project, committed
there, **in a folder named `.intent-loop/`** (its scripts and the agents refer to `.intent-loop/scripts/…`).
In the project (a git repo on `main` whose test command already passes):

1. Put this repo's files in `.intent-loop/` (download the zip from GitHub, or clone it and delete its `.git`).
2. Set `test_command` in `.intent-loop/intent-to-merge.yaml` to the project's test command (default `npm test`).
3. Optionally copy `.intent-loop/skills/intent-orchestrator/` to `.claude/skills/` (or your agent's skills folder).
4. Add `.task-state/`, `.digital-factory/`, `.digital-factory-outputs/`, `.copilot-cache/` and `.code-compass/` to `.gitignore`.
5. Commit on `main`, and set `git config user.name` / `user.email` in the project (the loop commits).
6. Run `.intent-loop/scripts/tick-loop.sh` (all intents) or `.intent-loop/scripts/orchestrate-tick.sh` (one).

Or let the installer do steps 1–4, run from the project:

```sh
<intent-loop>/install.sh --test "npm test"      # first install
<intent-loop>/install.sh --update               # newer loop version, keeps the project's test command
```

It also records the loop's version in `.intent-loop/VERSION`. It does not commit, and `--update` refuses to
overwrite uncommitted changes to the loop.

`BROWSER_CHECK=0` skips the Chromium check for projects without a UI; `DF_BIN` points to the engine if it is
not on the PATH, in `~/.digital-factory` or in a `.digital-factory` folder above the project.

Everything in `.intent-loop/` and `.claude/skills/intent-orchestrator/` is protected: a run that changes it is
rejected. Change the loop here and update projects again.
