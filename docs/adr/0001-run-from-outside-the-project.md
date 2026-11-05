# ADR-0001 · The factory runs from outside the project

- **Status:** Accepted (2026-11-05)
- **Fixed rules touched:** none (it strengthens “locked tests” and “gates decide”)

## Context
Peter's loop and the spec commit the loop (`.intent-loop/`, `.factory/`) into each project, and trust gate scripts because they are
read from the project's base branch. For the pilot, nothing of the factory may be committed to, or named in, a project repo (PLAN C1),
and the factory repo must hold no project IP (C7). Spike S1 showed that DF writes its outputs next to the workflow file, wherever `-w`
points.

## Decision
- The template, adapters (setup only) and rendered workflows live in the factory repo. Project worktrees hold only product changes.
- Each run copies the rendered workflow, prompts and gate scripts into `runs/<project>/<story>/<run>/` (gitignored) and runs DF there. Agents get `cwd` = the project worktree.
- **Trust anchor:** gates execute scripts from the run copy, and the run copy's hash is checked against the factory commit it was rendered from (`git -C $FACTORY show <commit>:…`). This replaces Peter's `git show <base-trust>:.intent-loop/…`.
- State, transcripts, logs and metrics stay in the run directory and are never pushed.
- An `isolation-check` gate before every push rejects any factory path in the story's commits. Commits stage explicit paths only.

## Consequences
- No ignore entries are needed in project repos. The project sees an ordinary branch and PR.
- Agents must not write into `runs/` or the factory repo. Enforced by `cwd` plus deny rules on those absolute paths (spike S2 shows path denies hold).
- Rejected: committing `.factory/` in the project (forbidden by C1); untracked DF files inside the worktree (not needed after S1).
