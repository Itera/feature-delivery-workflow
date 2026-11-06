# ADR-0003 · Right first time before the control plane: plan, test review, real host

- **Status:** Accepted (2026-11-06)
- **Fixed rules touched:** adds “A reviewed technical plan comes before code”, “Tests are reviewed before they are locked”,
  “Something checks the real host on every attempt” and “Every escaped defect changes the factory”; reorders spec §4.5.
- **Evidence:** [inc-0.md](../evidence/inc-0.md) §Escaped defect.

## Context
In the increment 0 pilot baseline, a backend (.NET) story passed every gate (tests GREEN, review CLEAR, validation PASS) and
reached publish, yet the application did not start: a dependency-injection captive dependency (a library registered our class as a
singleton; the class took a request-scoped service). Tracing it through the run records showed five layers, each of which could have
caught it:

| Layer | What happened |
|---|---|
| Story and architecture docs | Described *what* to build (classes, sources of data) but not *how the library wires it* (lifetimes). |
| Test author | Its test container registered the dependency with a different lifetime than the host, so the defect could not show in any test. Nobody reviewed the tests. |
| Builder | Looked up the dependency's lifetime but did not connect it to the library's registration; the tests were green. |
| Reviewer | The same prompt caught the defect in one round (a scratch DI check) and missed it in the next. Model depth varies by run. |
| Validator | Ran build and unit tests and recorded PASS without starting the app, against its own prompt. |

Two process gaps explain it, not one bad step:
1. **No technical plan.** Stories and architecture docs are functional; nothing turns them into a stack-specific plan (wiring,
   lifetimes, verified library behaviour, the test level per criterion) before code is written.
2. **Nobody checks the tests.** The tests are the only thing the deterministic gates trust, and they are written by an agent no one
   reviews. A test fixture that differs from production hides exactly the defects that matter.

The spec's final process (§2.1) already contains a red gate, mutation testing, a test-quality lens, an "app starts" check in
Validate and a seeded-defect eval set. But (a) triage's plan is about routing and splitting, not about the stack-specific *how*;
(b) the test-quality lens runs after implementation; and (c) the increment order puts the quality bar (increment 2) after a typed
control plane (increment 1) that by design changes no behaviour. Increment 0's own target, "you would merge at least 2 of 3 without
rework", cannot be met by Peter's loop alone.

## Decision
1. **Reorder the increments by what blocks real use.** New increment 1 is **Right first time** (route A, Opus where judgement
   matters, no cost optimisation). The typed control plane and the four-workflow split move to increment 2. Measure stays 3; cheaper
   review, parallel build and full coverage stay 4–6.
2. **Plan stage before tests and code** (spec §2.2 extended): a planner agent (read-only on the project, may spike in a scratch
   folder outside it) writes `plan.md` with fixed sections: change map, **wiring** (every registration with lifetime and reason,
   including types a library registers), **library facts** (each `verified: spike | docs | source` or `ASSUMPTION`), **test strategy
   per criterion** (level, fixture, what must not be faked), risks with the check that covers each. A script lints the plan; a fresh
   plan reviewer approves it or sends it back once. The plan is the contract for test author, builder and reviewers; deviating needs
   a recorded `PLAN_DEVIATION`. An approved plan is kept across attempts.
3. **Tests are reviewed before the lock.** After the test author: a deterministic **red check** (the acceptance tests run against the
   untouched code; if they all pass, they prove nothing) and a **test reviewer** that sees the story, the plan and the tests (there is
   no implementation yet): criterion coverage, assertion strength, mocks of the code under test, and **fixture fidelity** (a test
   container must register what the host registers, with the host's lifetimes, and validate scopes). One revision loop, then the
   attempt fails with feedback for the test author.
4. **The real host on every attempt.** Adapter `commands.boot` starts the app after a green test run and in preflight; a story
   that stops the app from starting gets `BOOT_FAIL`. The validator may not pass an endpoint criterion on tests alone.
5. **Stack packs.** Stack-specific rules live in `stacks/<stack>.md` (generic, no project IP), selected by the adapter's
   `project.stack`, and are read by the planner, plan reviewer, test reviewer and reviewer.
6. **Every escaped defect changes the factory.** A defect found after the gates leads to: the layer that should have caught it; a
   deterministic gate if possible, else a stack-pack rule; and a **seeded-defect fixture** that the factory's eval must catch from
   then on. The first one is the captive dependency.
7. **Mutation testing** stays in the quality bar but runs in increment 1 as an advisory deep check where the stack has a tool
   (Stryker.NET, StrykerJS): its report goes to the reviewer; a threshold blocks only once the eval shows it is stable.

## Consequences
- About 20–30 minutes and three agent calls more per story; fewer rounds wasted on defects found late.
- The plan and the test review add model judgement, but each sits behind a deterministic check (plan lint, red check, boot), so
  a weak judgement still meets a script.
- The control-plane rewrite starts from a workflow that already has its final stages, so parity tests cover the real thing.
- Increment 0 closes with the frontend pilot baseline not run; it becomes part of increment 1's verification.
