## Mission
Review the uncommitted/branch diff in `${repo_path}` (feature/${branch_slug} vs ${base_branch}) against the intent in `${intent_file}`. Do not modify code. Git is read-only for you: use only `git diff`, `git status`, `git log` and `git show`; never run `git commit`, `checkout`, `switch`, `stash`, `reset`, `restore`, `clean`, `add`, `merge`, `rebase` or `push`. The working tree and HEAD are fingerprinted before you start, and a CLEAR is rejected if either changed.

## Status Protocol
Start: `scripts/task-state.js set ${task_id} phase=reviewing status=in_progress 2>/dev/null || true`
End (CRITICAL — the gate reads the verdict from the state file, not from your output). Record it with ONE command (it sets verdict, attempt, phase, status and feedback atomically, checks the token and prints it back; it exits non-zero on a mistake, then fix and re-run it):
 - CLEAR: `scripts/task-state.js verdict ${task_id} reviewer CLEAR ${attempt}`
 - P0|P1: pass `-` and the feedback as a quoted heredoc (no escaping needed):
   ```
   scripts/task-state.js verdict ${task_id} reviewer <P0|P1> ${attempt} - <<'FEEDBACK'
   <feedback for the implementer, see below>
   FEEDBACK
   ```
 Never use `2>/dev/null` or `|| true` on this command.

## Review checklist
- Type errors / obvious logic bugs
- Acceptance tests (`*.acceptance.test.*`, written from the Success Metrics by a separate test author before implementation): does every Success Metric have a test with meaningful, specific assertions? A metric with no test, or a test that asserts something contrary to the intent = P1.
- Test integrity: changes that skip, exclude or neutralise tests (`.skip`/`.only`, edits to the test script, runner config or test discovery, mocks that bypass the code under test) = P0.
- Missing test coverage for other new behavior
- Security: input validation, injection, secrets or credentials in code
- Basic accessibility (labels, alt text, keyboard/focus) only if frontend code is touched
- Scope creep: changes outside the intent's scope

Use `git diff ${base_branch}` and `git status --porcelain` to see all changes. `git diff` does not show untracked files: read every `??` file listed by `git status` directly.

## Severity
P0 = must-fix blocker (broken, security hole). P1 = significant defect. Anything lower: mention but do not block.

## Feedback for the implementer (retries)
The orchestrator may re-run the workflow after a failure; the implementer reads `feedback.reviewer` from the state file. The feedback (heredoc body above) must contain: every P0/P1 finding as: severity, file:line, problem, suggested fix — one per line. On CLEAR the helper clears it automatically.

## Final output (CRITICAL)
The workflow gates on the verdict recorded by the End command; your final output must match it. Your final response must be EXACTLY one token and nothing else: CLEAR (no P0/P1 findings), P1 (worst finding is P1) or P0 (any P0).
