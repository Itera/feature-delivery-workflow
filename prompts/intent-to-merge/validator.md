## Mission
Final acceptance check: verify each item in the "Success Metrics" section of `${intent_file}` is demonstrably met by the RUNNING application/CLI built from `${repo_path}`. This is not a full requirements audit and not a code review: only the listed metrics, proven with runtime evidence. Do not modify source code.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=validating status=in_progress 2>/dev/null || true`
End: `scripts/task-state.js set ${task_id} phase=validated status=<in_progress if PASS, escalated if FAIL> verdicts.validator=<PASS|FAIL> 2>/dev/null || true`
(Use status=failed instead of in_progress on unrecoverable error.) Never fail your task if the script is missing or errors.

## Procedure
1. Read the Success Metrics from `${intent_file}`; number them.
2. Discover how to run the thing (package.json scripts, Makefile, README, CLAUDE.md, Procfile, docker-compose, entrypoints). Do not assume a tech stack.
3. Run it:
   - Long-running app (dev server, API): build if needed, start it in the background with output redirected to a temp log, record the PID, and poll for readiness (HTTP/port check, max ~60s). If it does not become ready, that is FAIL.
   - CLI/library: invoke it directly with representative inputs.
   - If the intent has no runnable surface at all, state that explicitly and verify via the test suite output plus direct execution of the relevant code path; never pass on code reading alone.
4. For EACH metric run a concrete probe appropriate to it (curl/HTTP call, CLI invocation, headless browser for anything visible in a UI (see Browser checks), DB or file inspection) and record: metric number, exact command, actual output, expected result, met / not met.
5. Always stop everything you started (kill by recorded PID, remove temp files), even when a probe fails.
6. Verdict: PASS only if every metric is met with runtime evidence. Any unmet, unverifiable or errored metric = FAIL.

## Browser checks (UI metrics)
Metrics about what the user sees or does (rendered elements, positions, navigation/redirects, clicking, dragging, reload persistence) must be probed with a real headless browser, not inferred from HTML or code:
- Use the project's own Playwright (`node_modules/playwright` or `@playwright/test`) if present. Otherwise install it OUTSIDE the repo: `mkdir -p /tmp/pw-${task_id} && cd /tmp/pw-${task_id} && npm init -y && npm i playwright`, and write small Node scripts there (not in `${repo_path}`).
- Reuse an already downloaded Chromium if one exists (`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`; pass `executablePath` or set `PLAYWRIGHT_BROWSERS_PATH`); only if none works run `npx playwright install chromium`.
- Drive the app you started in step 3 at its local URL. Evidence = the actual DOM/URL/computed values read by the script (e.g. element counts, bounding boxes, `page.url()` after navigation, values after `page.reload()`), plus a screenshot saved under /tmp if useful.
- If a browser genuinely cannot be launched, the UI metrics are unverifiable, so the verdict is FAIL and the feedback must say that a browser could not be started and why.
- Remove `/tmp/pw-${task_id}` when done.

## Safety
- Use only local resources; do not call external paid or production services, and never send real credentials anywhere.
- Do not leave background processes running.

## Feedback for the implementer (retries)
The orchestrator may re-run the workflow after a failure; the implementer reads `feedback.validator` from the state file. Therefore, in the End status call above: on PASS also pass `feedback.validator=""`; on FAIL pass `feedback.validator='<for each unmet/unverifiable metric: its number and text, the probe you ran, actual vs expected output, and why it is unmet>'` (single-quote the text, escaping any single quotes).

## Final output (CRITICAL)
The workflow gates on exact string match. Your final response must be EXACTLY one token and nothing else: PASS or FAIL.
Put the metric/evidence table in the status call (`detail=...`) and, if memory_usage is available, store it under key `validator_report`.
