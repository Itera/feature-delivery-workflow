# intent-loop

The intent-to-merge dev loop for the digital-factory engine: it takes intent files one by one and, for
each, writes acceptance tests, implements, tests, reviews, validates and merges it into the base branch.

```
planning/intents/*.md + .task-state/state.json        (written by the intent-planner skill)
  └─ scripts/tick-loop.sh                              ticks until LOOP: STOP
       └─ scripts/orchestrate-tick.sh                  one tick = one intent
            └─ digital-factory workflow run intent-to-merge.yaml
                 branch -> write tests -> lock -> implement -> test gate -> review -> validate -> merge
```

## Files

| File | What it is |
|---|---|
| `intent-to-merge.yaml` | The workflow: agents, models, tasks and their gates; `metadata.stages` groups the tasks for the workflow dashboard |
| `prompts/intent-to-merge/` | Prompts of the agents: test-author, implementer, tester, reviewer, validator, reporter |
| `scripts/orchestrate-tick.sh` | One tick: picks the next intent, runs the workflow on it, judges the result, prints `LOOP: CONTINUE` or `LOOP: STOP (<reason>)` |
| `scripts/tick-loop.sh` | Runs ticks until `LOOP: STOP` |
| `scripts/intent-git.sh` | The git steps (branch, snapshot, gates, merge, park) and the tamper guards, run from the committed base branch |
| `scripts/task-state.js` | Reads and writes `.task-state/state.json` |
| `scripts/intent-guard-ignore` | Paths the reviewer/validator may change while running the app |
| `.claude/skills/intent-orchestrator/` | Claude Code skill that runs one tick (`/intent-orchestrator`, or under `/loop`) |

## Using it in a project

The loop runs its scripts from the commit on the base branch, so it is copied into each project and
committed there, not referenced from here. In the project (a git repo on `main` whose test command passes):

1. Copy `intent-to-merge.yaml`, `prompts/`, `scripts/` and `.claude/skills/intent-orchestrator/` into it.
2. Set `test_command` in `intent-to-merge.yaml` to the project's test command (the default is `npm test`).
3. If the project's package.json has `"type": "module"`: add `scripts/package.json` with `{ "type": "commonjs" }`.
4. Add `.task-state/`, `.digital-factory/`, `.digital-factory-outputs/`, `.copilot-cache/` and `.code-compass/` to `.gitignore`.
5. Commit on `main`, and set `git config user.name` / `user.email` in the project (the loop commits).
6. Run `scripts/tick-loop.sh` (all intents) or `scripts/orchestrate-tick.sh` (one).

The loop's own files are protected: a run that changes them is rejected. Change the loop here and copy it
to projects again.
