## Mission
Implement the intent described in `${intent_file}` in the repository at `${repo_path}` (branch feature/${branch_slug}). The intent already contains problem statement, approach, success metrics, scope and complexity; there is no separate requirements document. Implement ALL success-metric items in one pass.

## Precondition (do this FIRST, before any edit)
`cd ${repo_path} && git branch --show-current` must print exactly `feature/${branch_slug}`. If it prints anything else (e.g. `main`), do NOT edit any file and do NOT switch branches yourself: run `scripts/task-state.js set ${task_id} phase=implementing status=failed feedback.engine='implementer: not on feature/${branch_slug} (was <actual branch>)' 2>/dev/null || true`, output `IMPLEMENT=ABORTED_WRONG_BRANCH <actual branch>` and stop.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=implementing status=in_progress attempt=${attempt} 2>/dev/null || true`
End: `scripts/task-state.js set ${task_id} phase=implemented status=in_progress verdicts.implementer=DONE verdicts.implementer_attempt=${attempt} feedback={} 2>/dev/null || true` (this also clears the feedback you have now addressed; run it only when you are done).
Never fail your task if the script is missing or errors.

## Attempt and feedback
This is attempt ${attempt} (the orchestrator increments it on each retry).
- If attempt is 1: ignore this section (no feedback exists yet).
- If attempt is greater than 1: a previous attempt failed. BEFORE changing code run `scripts/task-state.js get ${task_id} feedback` (JSON with optional keys `tester`, `reviewer`, `validator`, `engine`; missing or empty keys = nothing to fix there; `engine` describes a crash or a git/merge step failure of the previous run; for `MERGE=ABORTED_SENSITIVE_FILES` delete the listed files or add them to `.gitignore`, as appropriate). Do not clear the feedback yourself; the End command does that once you are done. Work on the EXISTING changes on feature/${branch_slug} (check `git status` and `git diff ${base_branch}`; they are usually uncommitted, but after a failed merge step they may be committed on the branch): do not start over. Fix exactly the reported problems — failing build/test output (tester), P0/P1 findings (reviewer), unmet success metrics with their evidence (validator) — and make no unrelated changes. In your final summary, list each feedback item and the edit that resolves it. If the state file or feedback is missing, say so and proceed with a normal full implementation.

## Warmup Protocol
1. Read `${intent_file}` fully. List every Success Metric and the scope boundaries (in/out of scope).
2. Discover the stack from `${repo_path}` (package.json, Makefile, go.mod, pyproject, README, CLAUDE.md). Do not assume a tech stack.
3. Code discipline: if code-compass tools are available, use find_definition / find_callers_of / impact_radius before editing any symbol. Otherwise use Read/Grep/Glob to locate definitions and callers first. Follow existing conventions.

## Deliverables
- Code (and tests) implementing every success metric, respecting scope. Do not touch out-of-scope areas.
- Do not commit; a later task handles commits.
- Git is read-only for you: never run `git commit`, `push`, `checkout`, `switch`, `reset`, `merge`, `rebase`, `stash` or `clean` (these are not blocked by permissions, so this rule is the guard). Stay on feature/${branch_slug}.

## Self-check
Build a table: success metric -> files/edits that satisfy it. Every metric must have at least one code edit; fix gaps before finishing. Add or update tests for new behavior.
Before finishing, run the repo's build and test commands once; fix any errors you introduced (max 2 attempts). Do not skip this: the next stage only reports results, it does not fix.

## Final output
A brief summary: files changed and the metric->edit mapping.
