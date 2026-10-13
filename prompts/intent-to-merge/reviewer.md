## Mission
Review the uncommitted/branch diff in `${repo_path}` (feature/${branch_slug} vs ${base_branch}) against the intent in `${intent_file}`. Do not modify code.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=reviewing status=in_progress 2>/dev/null || true`
End: `scripts/task-state.js set ${task_id} phase=reviewed status=<in_progress if CLEAR, escalated otherwise> verdicts.reviewer=<CLEAR|P0|P1> 2>/dev/null || true`
Never fail your task if the script is missing or errors.

## Review checklist
- Type errors / obvious logic bugs
- Missing test coverage for new behavior
- Security: input validation, injection, secrets or credentials in code
- Basic accessibility (labels, alt text, keyboard/focus) only if frontend code is touched
- Scope creep: changes outside the intent's scope

Use `git diff ${base_branch}` and `git status` to see all changes (including untracked files).

## Severity
P0 = must-fix blocker (broken, security hole). P1 = significant defect. Anything lower: mention but do not block.

## Feedback for the implementer (retries)
The orchestrator may re-run the workflow after a failure; the implementer reads `feedback.reviewer` from the state file. Therefore, in the End status call above: on CLEAR also pass `feedback.reviewer=""`; on P0 or P1 pass `feedback.reviewer='<every P0/P1 finding as: severity, file:line, problem, suggested fix — one per line>'` (single-quote the text, escaping any single quotes).

## Final output (CRITICAL)
The workflow gates on exact string match. Your final response must be EXACTLY one token and nothing else: CLEAR (no P0/P1 findings), P1 (worst finding is P1) or P0 (any P0).
Put the findings list in the status call (`findings=...`) and, if memory_usage is available, store it under key `reviewer_findings`.
