# Increment 0 · evidence (metrics and generic lessons only, rule C7)

Pilot details (story, code, diffs) stay in the gitignored `local/` and `runs/`.

## Runs

| Run | Story | Rounds × attempts | Outcome | Wall time per attempt |
|---|---|---|---|---|
| Fixture smoke 6 | fixture S01 (Node) | 1 × 1 | published (dry) | — |
| Fixture smoke 8 | fixture S01 (Node) | 1 × 1 | published (dry) | 24 min |
| Pilot BE r1 | backend story (.NET) | 1 × 3 | exhausted | 12 · 11 · 10 min |
| Pilot BE r2 | same | 1 × 3 | exhausted at publish | 19 · 14 · 36 min |
| Pilot BE r3 | same | 1 × 2 | published (dry), **not mergeable** | 23 · 38 min |
| Pilot FE | frontend story (Angular) | — | **not run**: moved to increment 1 verification | — |

Verdicts across the 8 backend attempts: test author DONE 7×, builder `TEST_DISPUTE` 2× (both a broken test setup, fixed by the
test author on the next attempt), tester `MODIFIED_TEST_SETUP` 2×, reviewer P0/P1 1×, reviewer CLEAR 2×, validator PASS 2×,
publish refused for PR length 1×.

## Factory defects found and fixed in increment 0

| Symptom | Cause | Fix |
|---|---|---|
| Round exhausted in minutes | Engine default per-task timeout (5 min) killed agents | `budget.agent_timeout_min` on every agent task |
| `MODIFIED_TEST_SETUP` on a legitimate story | Hash lock forbade the solution and project-reference additions the story needs | Additions-only setup check with a deny list; reviewer checks every added line |
| Board listed no runs | Log file name did not match the dashboard's runs mode | `delivery@<stamp>.log`, one shared board on a fixed port |
| Fresh round failed at once | Stale state file from an earlier round | Driver moves old round records aside |
| Feedback lost between attempts | State overwritten by the next attempt | `state-after.json` per attempt |
| Publish refused (PR too long) after all gates passed | Length checked only at publish | `check-pr` gate right after writing, one rewrite |
| Syntax error mid-run | Driver edited while a run executed it | Runs start from pinned, detached worktrees |

## Escaped defect: passed every gate, app does not start

- **What:** a .NET dependency-injection captive dependency. A library helper registered a class of the story as a singleton; the
  class's constructor took a request-scoped service. ASP.NET Core validates scopes in Development, so the host throws at startup;
  in other environments it fails silently (here harmless by luck, because the scoped service only read request-local state).
- **Gates passed:** build, unit and acceptance tests, review (CLEAR), validation (PASS), PR text.
- **Why each layer missed it** (from the run transcripts):
  - Story: named the classes, not the lifetime the library uses.
  - Test author: its test container registered the scoped dependency as a singleton, so no test could see the mismatch.
  - Builder: looked up the dependency's lifetime but not the library's registration; trusted green tests.
  - Reviewer: the same prompt caught this defect in the previous round with a scratch DI check, and missed it in this round.
  - Validator: built and ran unit tests, never started the app, recorded PASS.
- **Found by:** reviewing the published change outside the factory (a scratch DI container with scope validation, then starting
  the app).
- **Process changes:** [ADR-0003](../adr/0003-right-first-time-before-control-plane.md). Immediate gate: `commands.boot`
  (verified outside the factory: the defective round → `CRASHED` in 10 s, the previous round → `READY` in 17 s).

## Lessons
1. Agents meet the gate they are given and rarely go past it; anything that must hold on every run needs a deterministic check.
2. A test fixture that differs from production wiring is worse than a missing test: it makes the defect invisible.
3. Stories and architecture documents describe behaviour; a stack-specific plan has to turn that into wiring before code.
4. Increments should be ordered by what blocks real use. The quality bar blocks real use; the control plane does not.
