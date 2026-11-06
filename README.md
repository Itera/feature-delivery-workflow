# Feature delivery workflow (Itera delivery factory)

Turns one approved story into a reviewed, draft pull request. Agents do the work; deterministic gates decide; a human merges.
Built on the Digital Factory engine as a fork of `Itera/sdlc-workflow` (Peter's loop), following
[Feature Delivery Workflow.md](Feature%20Delivery%20Workflow.md) (the spec) and the build plan in [docs/PLAN.md](docs/PLAN.md).

The factory runs **outside** the project it works on: nothing of it is committed to the project. Only the project's ignored
`.itera/` folder is used locally ([ADR-0001](docs/adr/0001-run-from-outside-the-project.md)).

## Status (2026-11-05)

| Increment | Branch | State |
|---|---|---|
| 0 · Fork and run | `inc/0-fork-and-run` | **In progress.** Runs end to end on the smoke fixture (one attempt: tests → review → full tests → validate → PR text → dry publish). |
| 1 · Typed control plane | `inc/1-control-plane` | Not started |
| 2 · Quality bar | `inc/2-quality-bar` | Not started |
| 3 · Measure + setup skill | `inc/3-measure` | Not started |

Each increment gets its own worktree (`worktrees/inc-N`, gitignored), branched from the previous one, and ends with a tag
`inc-N-done` plus `docs/evidence/inc-N*.md`. Compare states with `git diff inc-0-done inc-1-done`.

## Increment 0: closed (2026-11-06)

Evidence: [docs/evidence/inc-0.md](docs/evidence/inc-0.md). A backend pilot story passed every gate and did not start; the
process answer is [ADR-0003](docs/adr/0003-right-first-time-before-control-plane.md) (plan, test review, real host; increments
reordered). The frontend baseline moved to increment 1.

## Continue here: increment 1 · Right first time

See [docs/PLAN.md](docs/PLAN.md) §4. Work in `worktrees/inc-1` (branch `inc/1-right-first-time`).

## Increment 0 checklist (done)

| # | Item | What done looks like | Where |
|---|---|---|---|
| 1 | **Board log naming + one shared board** | The driver writes `board/delivery@<YYYYMMDD-HHMMSS>.log` (the name the dashboard's runs mode expects) and reuses one board server on a fixed port that switches to the current run, so the Lemmings theme stays on. Stops board servers of finished runs. | `scripts/factory-run.sh` §2b |
| 2 | **Platform independence** | Adapter `platform` block (`os`, `df_bin`, `open_cmd`) with per-OS defaults; platform code isolated: process cleanup (`taskkill` / `kill`), path conversion (`cygpath` on Windows only), opening the board (`explorer.exe` / `open` / `xdg-open`), run timeout (`timeout` / `gtimeout` / watchdog). Windows stays the default. | schema, `story-git.sh` `kill_recorded`, `factory-run.sh` |
| 3 | **Change guide** (`explain` step after publish) | Local interactive HTML: acceptance criteria → changes → tests, gate and review results. The agent writes only text (JSON); a script builds every code link from the real diff (`vscode://file/…:line` + permalink `blob/<sha>/<path>#L<a>-L<b>`). Written to `.itera/guide/<id>.html` and `runs/`; never committed or linked from the PR (C8). | new `prompts/explainer.md`, `scripts/guide.mjs`, workflow task |
| 4 | **Smoke run after 1–3** | Fixture story publishes in one attempt; board follows it; guide opens with working links. | `evals/fixture-node/make.sh`, then `factory-run.sh fixture-node S01` |
| 5 | **Pilot baseline (dry)** | Both pilot stories (backend .NET, frontend Angular) reach `publish` in dry mode; PR text and guide written locally, nothing pushed. The orchestrating session snapshots each tracker issue and passes it with `--id <KEY> --spec <file>`. Pilot specifics: `local/` (not in git). | `factory-run.sh <project> <story> --id … --spec … --publish dry` |
| 6 | **Close increment 0** | `docs/evidence/inc-0.md` (metrics only: attempts, verdicts, timings, cost, lessons), tag `inc-0-done`, push. | |

Item 5: backend done (3 rounds), frontend moved to increment 1. Item 6: this section and the evidence file.

### Decided and already built
- Trusted gates: every command task is `git show <trust>:scripts/launch.sh | sh -s -- …` (quote-free through cmd.exe; the script and the project config come from the factory commit, not from disk).
- Every agent declares its tool surface: no MCP tools, no `PowerShell`, no sub-agents ([ADR-0002](docs/adr/0002-agent-tool-surface.md)).
- Staged tests: fast suite (incl. locked acceptance tests) every attempt; full suite once after review is CLEAR (`full-tests` gate).
- Story base per story (`git.story_base`), draft PR to that base, assignees from the adapter, no reviewers.
- Hidden disclosure: the CLI's attribution footer is stripped (and logged); anything else naming the tooling blocks publishing. PR text is checked before anything is committed.
- `isolation_violations()`: `.itera/` must stay ignored and uncommitted; any other factory path anywhere fails the run.
- Tracker issue as story input (`--id`, `--spec`): the issue wins on outcome / acceptance criteria / scope; the task file adds the how. No tracker writes.

### Open questions (spec §4.7 and found while building)
- Code Compass for agents: blocked by the `mcp__*` deny; decide in increment 3 (deterministic code-intel step vs. a narrow allow).
- A stacked story base moves (its PR is rebased or merged) → today `BASE_MOVED` stops publish; decide the rebase policy.
- Retries re-run the test author every attempt; spec §2.5 wants it skipped while the lock is valid (increment 1).

## How to run

```bash
# once per project: render the template with the project's adapter (commit the result; the driver refuses drift)
node scripts/render.mjs <project>

# smoke test on the fixture (fresh fixture each time)
bash evals/fixture-node/make.sh
bash scripts/factory-run.sh fixture-node S01 --publish dry

# a real story (dry first; --publish draft-pr opens the PR)
bash scripts/factory-run.sh <project> <story> --id <KEY> --spec <tracker-snapshot.md> --publish dry
```

Requirements: Git for Windows (Git Bash), Node 22+, the `digital-factory` engine (`DF_BIN`, default under the pilot folder), `gh`
logged in with the project's account. Run records land in `runs/` (gitignored); the board opens automatically.

## Layout

| Path | What |
|---|---|
| `workflows/delivery.yaml` | Workflow template (Peter's sdlc, ported) |
| `prompts/` | Agent prompts: test-author, implementer, tester, reviewer, validator, pr-writer, reporter |
| `scripts/launch.sh`, `scripts/story-git.sh` | Trusted launcher and all gates (port of `intent-git.sh`) |
| `scripts/render.mjs` | Template + adapter + overrides → `projects/<p>/generated/`; fixed-rule and drift checks |
| `scripts/factory-run.sh` | Driver: worktree per round, run copy per attempt, judge, park, board |
| `scripts/task-state.js` | State store (`--state <file>`) |
| `schemas/adapter.schema.json` | Adapter schema (setup only, no project IP) |
| `projects/<p>/` | `adapter.json` + rendered `generated/` |
| `evals/fixture-node/` | Smoke-test fixture and its story |
| `dashboard/` | Peter's workflow-dashboard (vendored) |
| `docs/` | Plan, ADRs, evidence |
| `local/`, `runs/`, `worktrees/` | Gitignored: pilot specifics, run records, increment worktrees |

## Rules for this repo
- No project IP or secrets: tech stack and setup only (PLAN C7). Run records and pilot details stay in `runs/` and `local/`.
- Push directly to this repo while the workflow is being set up; increments stay on their own branches.
