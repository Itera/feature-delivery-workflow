## Mission
Implement the intent described in `${intent_file}` in the repository at `${repo_path}` (branch feature/${branch_slug}). The intent already contains problem statement, approach, success metrics, scope and complexity; there is no separate requirements document. Implement ALL success-metric items in one pass.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=implementing status=in_progress attempt=${attempt} 2>/dev/null || true`
End: `scripts/task-state.js set ${task_id} phase=implemented status=in_progress 2>/dev/null || true`
Never fail your task if the script is missing or errors.

## Attempt and feedback
This is attempt ${attempt} (the orchestrator increments it on each retry).
- If attempt is 1: ignore this section (no feedback exists yet).
- If attempt is greater than 1: a previous attempt failed. BEFORE changing code run `scripts/task-state.js get ${task_id} feedback` (JSON with optional keys `tester`, `reviewer`, `validator`; missing keys = nothing to fix there). Then run `scripts/task-state.js set ${task_id} feedback={} 2>/dev/null || true` so stale feedback is cleared. Work on the EXISTING changes on feature/${branch_slug} (they are uncommitted in the working tree; check `git status` and `git diff`): do not start over. Fix exactly the reported problems — failing build/test output (tester), P0/P1 findings (reviewer), unmet success metrics with their evidence (validator) — and make no unrelated changes. In your final summary, list each feedback item and the edit that resolves it. If the state file or feedback is missing, say so and proceed with a normal full implementation.

## Warmup Protocol
1. Read `${intent_file}` fully. List every Success Metric and the scope boundaries (in/out of scope).
2. Discover the stack from `${repo_path}` (package.json, Makefile, go.mod, pyproject, README, CLAUDE.md). Do not assume a tech stack.
3. Code discipline: if code-compass tools are available, use find_definition / find_callers_of / impact_radius before editing any symbol. Otherwise use Read/Grep/Glob to locate definitions and callers first. Follow existing conventions.

## Deliverables
- Code (and tests) implementing every success metric, respecting scope. Do not touch out-of-scope areas.
- Do not commit; a later task handles commits.

## Self-check
Build a table: success metric -> files/edits that satisfy it. Every metric must have at least one code edit; fix gaps before finishing. Add or update tests for new behavior.
Before finishing, run the repo's build and test commands once; fix any errors you introduced (max 2 attempts). Do not skip this: the next stage only reports results, it does not fix.

## Final output
A brief summary: files changed and the metric->edit mapping.
