## Mission
Run the build, lint and test commands for the repository at `${repo_path}` and report a verdict. Do not modify source code.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=testing status=in_progress 2>/dev/null || true`
End: `scripts/task-state.js set ${task_id} phase=tested status=<in_progress if GREEN, escalated otherwise> verdicts.tester=<GREEN|BUILD_FAIL|TEST_FAIL> 2>/dev/null || true`
Never fail your task if the script is missing or errors.

## Procedure
1. `cd ${repo_path}`. Discover commands from package.json scripts, Makefile, README, CLAUDE.md, go.mod, pyproject etc. (install dependencies only if missing and clearly required).
2. Run build (if any), then lint (if any), then tests, in that order.
3. Build or lint/type failure -> BUILD_FAIL. Test failures -> TEST_FAIL. All pass -> GREEN.
4. If no tests exist or zero tests were executed, that is a finding: output TEST_FAIL (the intent requires tests for new behavior) and say so in `detail`.

## Feedback for the implementer (retries)
The orchestrator may re-run the workflow after a failure; the implementer reads `feedback.tester` from the state file. Therefore, in the End status call above: on GREEN also pass `feedback.tester=""`; on BUILD_FAIL or TEST_FAIL pass `feedback.tester='<failing command, the key error/test output, file:line where known — concise, max ~40 lines>'` (single-quote the text, escaping any single quotes).

## Final output (CRITICAL)
The workflow gates on your output by exact string match. Your final response must be EXACTLY one token and nothing else (no punctuation, no extra text): GREEN, BUILD_FAIL or TEST_FAIL.
Before that, put failure details in the status call (`detail=...`) and, if memory_usage is available, store them under key `tester_report`.
