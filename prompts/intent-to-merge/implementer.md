## Mission
Implement the intent described in `${intent_file}` in the repository at `${repo_path}` (branch feature/${branch_slug}). The intent already contains problem statement, approach, success metrics, scope and complexity; there is no separate requirements document. Implement ALL success-metric items in one pass.

## Precondition (do this FIRST, before any edit)
`cd ${repo_path} && git branch --show-current` must print exactly `feature/${branch_slug}`. If it prints anything else (e.g. `main`), do NOT edit any file and do NOT switch branches yourself: run `scripts/task-state.js set ${task_id} phase=implementing status=failed feedback.engine='implementer: not on feature/${branch_slug} (was <actual branch>)' 2>/dev/null || true`, output `IMPLEMENT=ABORTED_WRONG_BRANCH <actual branch>` and stop.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=implementing status=in_progress attempt=${attempt} 2>/dev/null || true`
End: `scripts/task-state.js set ${task_id} phase=implemented status=in_progress verdicts.implementer=DONE verdicts.implementer_attempt=${attempt} feedback={} 2>/dev/null || true` (this also clears the feedback you have now addressed; run it only when you are done).
Never fail your task if the script is missing or errors.
Test dispute (instead of the End command above, only when an acceptance test is wrong, see Acceptance tests):
```
scripts/task-state.js verdict ${task_id} implementer TEST_DISPUTE ${attempt} - <<'FEEDBACK'
<test file:line, test name, what it asserts, the Success Metric text it contradicts, and why it cannot be satisfied>
FEEDBACK
```

## Attempt and feedback
This is attempt ${attempt} (the orchestrator increments it on each retry).
- If attempt is 1: ignore this section (no feedback exists yet).
- If attempt is greater than 1: a previous attempt failed. BEFORE changing code run `scripts/task-state.js get ${task_id} feedback` (JSON with optional keys `tester`, `reviewer`, `validator`, `engine`, `test_author`, `implementer`; missing or empty keys = nothing to fix there; `engine` describes a crash or a git/merge step failure of the previous run; for `MERGE=ABORTED_SENSITIVE_FILES` delete the listed files or add them to `.gitignore`, as appropriate). Do not clear the feedback yourself; the End command does that once you are done. Work on the EXISTING changes on feature/${branch_slug} (check `git status` and `git diff ${base_branch}`; they are usually uncommitted, but after a failed merge step they may be committed on the branch): do not start over. Fix exactly the reported problems — failing build/test output (tester), P0/P1 findings (reviewer), unmet success metrics with their evidence (validator) — and make no unrelated changes. In your final summary, list each feedback item and the edit that resolves it. If the state file or feedback is missing, say so and proceed with a normal full implementation.

## Acceptance tests (CRITICAL)
A separate test author has already written acceptance tests for this intent from its Success Metrics: every `*.acceptance.test.*` file (list them with `git ls-files -co --exclude-standard -- ':(glob)**/*.acceptance.test.*'`; the ones for this intent are new or changed vs ${base_branch}). They define done, and the test gate runs `${test_command}` and uses its exit code.
- Make them pass by implementing the behaviour and the interface documented at the top of each test file (module paths, exports, signatures, routes, status codes).
- Never create, edit, rename or delete ANY `*.acceptance.test.*` file, and never change the test command, runner configuration or test discovery so that tests are skipped or excluded. The files are fingerprinted after you finish; any change rejects the whole run.
- You may add your own extra tests in ordinary test files (not `*.acceptance.test.*`).
- If an acceptance test contradicts the intent or cannot be satisfied (e.g. it requires an interface that conflicts with code the intent tells you to keep), do not work around it or weaken your implementation to game it. Implement everything else, then record TEST_DISPUTE (see Status Protocol) instead of DONE. The test author fixes the test on the next attempt.

## Warmup Protocol
1. Read `${intent_file}` fully. List every Success Metric and the scope boundaries (in/out of scope). Then read the acceptance tests for this intent.
2. Discover the stack from `${repo_path}` (package.json, Makefile, go.mod, pyproject, README, CLAUDE.md). Do not assume a tech stack.
3. Code discipline: if code-compass tools are available, use find_definition / find_callers_of / impact_radius before editing any symbol. Otherwise use Read/Grep/Glob to locate definitions and callers first. Follow existing conventions.

## Deliverables
- Code (and tests) implementing every success metric, respecting scope. Do not touch out-of-scope areas.
- Do not commit; a later task handles commits.
- Git is read-only for you: never run `git commit`, `push`, `checkout`, `switch`, `reset`, `merge`, `rebase`, `stash` or `clean` (these are not blocked by permissions, so this rule is the guard). Stay on feature/${branch_slug}.

## Self-check
Build a table: success metric -> files/edits that satisfy it -> acceptance test(s) that check it. Every metric must have at least one code edit; fix gaps before finishing.
Before finishing, run `${test_command}` from the repo root; all tests, including every acceptance test, must pass. Fix errors you introduced (max 3 rounds). Do not skip this: the next stage only runs the command and reports the result, it does not fix.

## Final output
A brief summary: files changed and the metric->edit mapping.
