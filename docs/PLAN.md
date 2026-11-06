# Delivery factory: build plan (increments 0–3) and pilot verification

Source spec: [Feature Delivery Workflow.md](../Feature%20Delivery%20Workflow.md) (“the spec”). This plan builds spec §4.5
increments 0–3 in this repo (a fork of `Itera/sdlc-workflow` with its history kept), then verifies the result by delivering two
real stories in a pilot project: one backend story (.NET) and one frontend story (Angular).

**Project-specific details stay out of this repo.** Story names, task files, branch history and anything else beyond tech stack and
setup live in a local, gitignored file (`local/<pilot>.md`). Project adapters in `projects/` hold setup only (rule C7).

## 1 · Hard constraints for the pilot

| # | Constraint | How it is enforced |
|---|---|---|
| C1 | **No factory file is ever committed to the pilot repos.** The one local folder the factory may use inside a project worktree is `.itera/`, which the project ignores through a one-line setup PR. | Run records, state and DF outputs stay in this repo's gitignored `runs/`. `isolation_violations()` fails the test gate and publish if `.itera/` is committed, staged or not ignored, or if any other factory path (`.digital-factory*`, `.task-state`, `.factory`, …) appears anywhere, ignored or not. Commits stage only the story's paths. |
| C2 | Each story in **its own worktree**, cut from a configured **story base** (the setup branch, which sits on the team's current branch). | `git.story_base` in the adapter. Worktree `<worktree_root>/<local_id>-<slug>-r<K>` (K = round). A failed round is discarded: worktree removed, branch deleted locally and on the remote, draft PR closed. |
| C3 | PRs **assigned only to the pilot lead**: no reviewers, no other assignees. Each PR targets the branch its story was cut from. | `publish`: `gh pr create --draft --base <story_base> --assignee <adapter assignees>` with the project's gh account (switched and restored). |
| C4 | Disclosure **hidden**. | No AI, DF or Code Compass in PRs, commits or branches; the project's author identity; no co-author trailers. The known CLI attribution footer is stripped and logged; anything else that names the tooling blocks publishing. |
| C5 | **No tracker writes** (local story ids). The docs repo is written only when a story produces docs, through its own worktree and a draft PR, never merged or pushed to `main`. | No `tracker` block in the adapter; docs as a companion repo with `never_push`. Task files are read, never edited. |
| C6 | Each factory **increment in its own worktree**, stacked, kept as evidence. | §3. |
| C7 | **No project IP or secrets in the factory repo.** Allowed: tech stack, build and test commands, folder conventions, branch names, tool choices. Not allowed: source code, diffs, task or spec text, domain rules, customer data, tokens, connection strings. | `projects/<repo>/` hold setup only. Run records stay in gitignored `runs/`. Evidence files contain metrics, verdict counts, timings, cost and generic lessons. A `no-ip` check in CI greps committed files. |
| C8 | **The change guide stays local.** | Written only to `.itera/` (ignored) and `runs/` (gitignored). The PR doesn't mention it. |

## 2 · Architecture deltas from the spec

The spec, like Peter's loop, commits the adapter and generated workflows into the project. C1 forbids that, so the factory runs
**from outside** the project ([ADR-0001](adr/0001-run-from-outside-the-project.md)).

| Spec / Peter | Here | Consequence |
|---|---|---|
| `.intent-loop/` committed in the project; gates read `git show <base-trust>:.intent-loop/…` | Trust anchor = **a factory commit**: every gate is `git show <trust>:scripts/launch.sh \| sh -s -- …` (quote-free, works through cmd.exe) | Same tamper protection; the builder cannot reach the code that judges it. |
| `.task-state/` in the project | `runs/<project>/<story>/r<K>/state.json` in the factory repo (gitignored) | |
| Adapter + generated workflow in the project | `projects/<repo>/adapter.json` + `generated/` (rendered, committed, drift-checked) in the factory repo | The gates also read `generated/config.json` from the trusted commit. |
| Intent files in the project | The task file is read from the docs repo, copied into the run and hashed | `PLAN_CHANGED` as in Peter's loop. |
| One base branch | **Story base per story** (`git.story_base`) | Preflight, baseline and PR target use it. |
| Merge to base | Push + **draft PR**, human merge | |
| Agents inherit the user's tools | Every agent declares its tool surface ([ADR-0002](adr/0002-agent-tool-surface.md)) | No MCP tools, no `PowerShell`, no sub-agents; side effects only in command tasks. |

```
feature-delivery-workflow/
├─ workflows/ prompts/ scripts/   template: delivery.yaml, agent prompts, launch.sh, story-git.sh, render.mjs, factory-run.sh
├─ schemas/adapter.schema.json
├─ projects/<repo>/               adapter.json (setup only) · generated/ (rendered)
├─ evals/fixture-node/            smoke-test fixture (+ .NET fixture with seeded defects in increment 2)
├─ dashboard/                     Peter's workflow-dashboard (vendored), started by the driver
├─ cli/  security/  skill/        increments 1–3
├─ docs/  PLAN.md · adr/ · evidence/
├─ local/                         gitignored: pilot specifics
├─ runs/                          gitignored: run records
└─ worktrees/inc-N/               gitignored: one worktree per increment
```

## 3 · Worktree map

| Worktree | Branch | Base | Ends with |
|---|---|---|---|
| `.` | `main` | upstream history | spec, plan |
| `worktrees/inc-0` | `inc/0-fork-and-run` | `main` | tag `inc-0-done` + evidence |
| `worktrees/inc-1` | `inc/1-right-first-time` | `inc/0-…` | tag `inc-1-done` + evidence |
| `worktrees/inc-2` | `inc/2-control-plane` | `inc/1-…` | tag `inc-2-done` + evidence |
| `worktrees/inc-3` | `inc/3-measure` | `inc/2-…` | tag `inc-3-done` + evidence |

Compare any two states with `git diff inc-1-done inc-2-done`.

## 4 · Increments

Route A only (triage and routes B/C are increments 5–6). Every agent on the Claude runtime.

### Increment 0 · Fork and run
- Spikes S1–S7 ([evidence](evidence/inc-0-spikes.md)): isolation, deny rules, cmd.exe shell, gh accounts, advisor, tool surface, quoting.
- `sdlc` → `delivery`: Claude runtime, declared tool surfaces, preflight on the story base, pr-writer, publish (draft PR) instead of merge, staged tests (fast suite every attempt, full suite once after review).
- Adapter v0 + schema + `render` (template + values + overrides, fixed-rule check, drift check).
- Driver: worktree per round, run copy per attempt, judge by the state file, park; the live board (Lemmings theme).
- **Platform independence:** Windows default; adapter `platform` block (`os`, `df_bin`, `open_cmd`); per-OS functions for process cleanup, path conversion, opening the board and the run timeout; the setup skill detects the OS.
- **Change guide:** an `explain` step after publish writes a local interactive HTML guide (criteria → changes → tests, gate and review results). The agent writes only text; a script builds every code link from the real diff (local editor link and a permalink to the PR commit). Local only (C8).
- **Done when:** the fixture story reaches a dry PR; baseline runs of both pilot stories reach publish in dry mode.

Order changed by [ADR-0003](adr/0003-right-first-time-before-control-plane.md): the quality work that blocks real use comes before the
control-plane rewrite.

### Increment 1 · Right first time
- **Plan stage:** planner (Opus, read-only on the project, spikes in the run's scratch folder) writes `plan.md` (change map, wiring with lifetimes, library facts with how each was verified, test strategy per criterion, risks); `plan-lint` (script); fresh plan reviewer (APPROVED / REVISE, one revision); an approved plan is kept across attempts.
- **Tests before the lock:** `red-check` (acceptance tests on the untouched code must not all pass; passing ones are listed), test reviewer (story + plan + tests, fixture fidelity), one revision.
- **Real host:** `commands.boot` in preflight and after every green test run (`BOOT_FAIL`); validator may not pass an endpoint on tests alone.
- **Stack packs:** `stacks/dotnet.md`, `stacks/angular.md`; the reviewer checks the code against the plan.
- **Mutation (advisory):** Stryker on changed files where the adapter configures it; report to the reviewer.
- **Seeded defects (gate level):** `evals/seeded/`, one fixture per escaped defect; `evals/seeded/run.sh` must report every one caught.
- **Done when:** seeded defects caught; the escaped backend pilot story reaches a dry PR that boots and that the pilot lead would merge without rework; the frontend baseline reaches publish.

### Increment 2 · Typed control plane + quality bar
- One TypeScript CLI `factory`: state machine (Peter's states + `pr_open`, `changes_requested`, `paused_cost`), git ops and guards, gates, render, adapter validation; parity tests against recorded runs; unit and workflow-contract tests with fake agents; CI.
- Split into `prepare` / `build` / `verify` / `publish` workflows; check registry in the adapter; Itera security standard v0; 4 review lenses; blocking mutation threshold.
- **Done when:** parity on recorded runs; bash only in thin wrappers; every seeded defect caught.

### Increment 3 · Measure + setup skill
- Cost snapshots and pause, deferral ledger, stall detection, code-intel metrics, run records and dashboard columns, disclosure modes, extension slots.
- `skill/factory-setup`: `init` · `explain` · `change` · `upgrade` · `contribute`.
- **Done when:** every run writes a complete metrics row; `factory-setup init` reproduces the pilot adapters.

## 5 · Pilot verification (after `inc-3-done`)
1. Preflight on each story base; a red base is never a round.
2. Round r1 of each story → draft PR assigned to the pilot lead.
3. The pilot lead reviews. Accepted = would merge without rework.
4. Not accepted → discard the round, fix the template through a local override → `contribute`, run the next round.
5. Results (metrics only) in `docs/evidence/verification.md`.

## 6 · Setup-skill interview topics
Repos and branching · build and test commands (staged by cost) · acceptance-test pattern and test infrastructure · platform (detected) · publish conventions and project CI · checks and security tools · models, parallelism, budget · code intelligence. Detect first, ask second; at most 4 questions per round, recommended answer first.

## 7 · Out of scope
Increments 4–6 (Haiku sweep, route B/C, adversarial tester), tracker integration, nightly evals.
