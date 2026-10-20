#!/usr/bin/env bash
# Deterministic git steps for the intent-to-merge workflow (run from the repo root).
#   intent-git.sh branch <task_id> <branch_slug> <base_branch>   create/reuse feature/<slug>, reset verdicts
#   intent-git.sh merge  <task_id> <branch_slug> <base_branch>   commit, merge --no-ff into base, delete branch
# Prints one result line on stdout; exits non-zero on failure (after recording status=failed).
set -uo pipefail

# Agent hosts (e.g. Copilot CLI) export GIT_CONFIG_COUNT/KEY_n/VALUE_n; nested processes can inherit
# them half-stripped, which makes every git call fail with "missing config key GIT_CONFIG_KEY_0".
for v in $(env | grep -oE '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)='); do unset "${v%=}"; done

cmd=${1:-}; task_id=${2:-}; slug=${3:-}; base=${4:-}
if [ -z "$cmd" ] || [ -z "$task_id" ] || [ -z "$slug" ] || [ -z "$base" ]; then
  echo "usage: intent-git.sh branch|merge <task_id> <branch_slug> <base_branch> (all required)" >&2
  exit 2
fi
feature="feature/$slug"
state=scripts/task-state.js
excl=(':(exclude).task-state' ':(exclude)scripts/task-state.js' ':(exclude).copilot-cache')

st() { "$state" set "$task_id" "$@" >/dev/null 2>&1 || true; }
fail() { st "phase=$1" status=failed "feedback.engine=$2: $3"; echo "$2 $3"; exit 1; }
has_origin() { git remote get-url origin >/dev/null 2>&1; }

case "$cmd" in
branch)
  st phase=branched status=in_progress
  "$state" set "$task_id" 'verdicts={}' >/dev/null || fail branched BRANCH=FAILED state-reset
  has_origin && { git fetch -q origin "$base" 2>/dev/null || true; }
  cur=$(git branch --show-current)
  if [ "$cur" != "$feature" ]; then
    # Never carry uncommitted work from another branch into this intent.
    [ -z "$(git status --porcelain -- . "${excl[@]}")" ] || fail branched BRANCH=FAILED "dirty-tree-on:$cur"
    git checkout -q "$base" || fail branched BRANCH=FAILED "checkout:$base"
    has_origin && { git pull -q --ff-only 2>/dev/null || true; }
    if git show-ref --verify --quiet "refs/heads/$feature"; then
      git checkout -q "$feature" || fail branched BRANCH=FAILED "checkout:$feature"
    else
      git checkout -q -b "$feature" || fail branched BRANCH=FAILED "create:$feature"
    fi
  fi
  [ "$(git branch --show-current)" = "$feature" ] || fail branched BRANCH=FAILED "not-on:$feature"
  st phase=branched status=in_progress "branch=$feature" feedback.engine='""'
  echo "BRANCH=$feature BASE=$base"
  ;;
merge)
  st phase=merging status=in_progress
  [ "$(git branch --show-current)" = "$feature" ] || fail merging MERGE=FAILED "not-on:$feature"
  # Add everything, then unstage the orchestrator's own files. (Exclude pathspecs in `git add` exit 1
  # when the excluded path is also gitignored.)
  git add -A -- . || fail merging MERGE=FAILED git-add
  for p in .task-state scripts/task-state.js .copilot-cache; do git reset -q -- "$p" 2>/dev/null || true; done
  bad=$(git diff --cached --name-only \
    | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|(^|/)id_rsa|(^|/)node_modules/|\.log$|(^|/)dist/|(^|/)build/|\.db$' \
    | grep -vE '(^|/)\.env\.example$' | tr '\n' ' ')
  if [ -n "$bad" ]; then git reset -q; fail merging MERGE=ABORTED_SENSITIVE_FILES "$bad"; fi
  if ! git diff --cached --quiet; then
    git commit -q -m "feat($slug): implement intent $task_id" || fail merging MERGE=FAILED commit
  fi
  [ "$(git rev-list --count "$base..$feature")" -gt 0 ] || fail merging MERGE=FAILED nothing-to-merge
  pushed=no
  if has_origin; then git push -q -u origin "$feature" || fail merging MERGE=FAILED push-feature; pushed=yes; fi
  git checkout -q "$base" || fail merging MERGE=FAILED "checkout:$base"
  if ! git merge -q --no-ff "$feature" -m "Merge $feature"; then
    git merge --abort 2>/dev/null; git checkout -q "$feature"
    fail merging MERGE=CONFLICT "$feature->$base"
  fi
  sha=$(git rev-parse HEAD)
  if has_origin; then git push -q origin "$base" || fail merging MERGE=FAILED "push:$base"; fi
  deleted=no
  git branch -q -d "$feature" && deleted=yes
  [ "$pushed" = yes ] && { git push -q origin --delete "$feature" 2>/dev/null || true; }
  st phase=completed status=completed "commit=$sha"
  echo "COMMIT=$sha MERGE=OK BRANCH_DELETED=$deleted"
  ;;
*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
