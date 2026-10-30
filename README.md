# intent-loop

The intent-to-merge dev loop for the digital-factory engine: it takes intent files one by one and, for
each, writes acceptance tests, implements, tests, reviews, validates and merges it into the base branch.

```
planning/intents/*.md + .task-state/state.json        (written by the intent-planner skill)
  └─ .intent-loop/tick-loop.sh                         ticks until LOOP: STOP
       └─ .intent-loop/orchestrate-tick.sh             one tick = one intent
            └─ digital-factory workflow run .intent-loop/intent-to-merge.yaml
                 branch -> write tests -> lock -> implement -> test gate -> review -> validate -> merge
```

## Install into a project

The loop runs its scripts from the commit on the base branch, so it is copied into each project and
committed there. From the project (a git repo on `main` whose test command already passes):

```sh
<intent-loop>/install.sh --test "npm test"      # first install
<intent-loop>/install.sh --update               # newer loop version, keeps the project's test command
```

It puts the whole loop in one folder, `.intent-loop/`, plus its skill in `.claude/skills/intent-orchestrator/`,
sets `test_command`, records the version in `.intent-loop/VERSION` and adds the loop's runtime folders
(`.task-state/`, `.digital-factory/`, …) to `.gitignore`. It does not commit, and `--update` refuses to
overwrite uncommitted changes to the loop. Then:

```sh
git add .intent-loop .claude/skills/intent-orchestrator .gitignore && git commit -m "intent loop"
git config user.name ... && git config user.email ...      # the loop commits
.intent-loop/tick-loop.sh                                   # all intents (orchestrate-tick.sh runs one)
```

`BROWSER_CHECK=0` skips the Chromium check for projects without a UI; `DF_BIN` points to the engine if it is
not on the PATH, in `~/.digital-factory` or in a `.digital-factory` folder above the project.

## Files

| Repo path | In the project | What it is |
|---|---|---|
| `install.sh` | — | Installs or updates the loop in a project |
| `loop/intent-to-merge.yaml` | `.intent-loop/` | The workflow: agents, models, tasks and their gates; `metadata.stages` groups the tasks for the workflow dashboard |
| `loop/prompts/` | `.intent-loop/prompts/` | Prompts of the agents: test-author, implementer, tester, reviewer, validator, reporter |
| `loop/orchestrate-tick.sh` | `.intent-loop/` | One tick: picks the next intent, runs the workflow on it, judges the result, prints `LOOP: CONTINUE` or `LOOP: STOP (<reason>)` |
| `loop/tick-loop.sh` | `.intent-loop/` | Runs ticks until `LOOP: STOP` |
| `loop/intent-git.sh` | `.intent-loop/` | The git steps (branch, snapshot, gates, merge, park) and the tamper guards, run from the committed base branch |
| `loop/task-state.js` | `.intent-loop/` | Reads and writes `.task-state/state.json` |
| `loop/intent-guard-ignore` | `.intent-loop/` | Paths the reviewer/validator may change while running the app |
| `loop/package.json` | `.intent-loop/` | Marks the loop's scripts as CommonJS, whatever the project uses |
| `skills/intent-orchestrator/` | `.claude/skills/intent-orchestrator/` | Agent skill that runs one tick (`/intent-orchestrator`; in Claude Code also under `/loop`) |

Everything in `.intent-loop/` and the orchestrator skill is protected: a run that changes them is rejected.
Change the loop here and update projects with `install.sh --update`.
