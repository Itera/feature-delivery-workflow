#!/usr/bin/env bash
# Deterministic git steps for the intent-to-merge workflow (run from the repo root).
#   intent-git.sh branch <task_id> <branch_slug> <base_branch>   create/reuse feature/<slug>, reset verdicts
#   intent-git.sh merge  <task_id> <branch_slug> <base_branch>   commit, merge --no-ff into base, delete branch
#   intent-git.sh snapshot <task_id> <branch_slug> <base_branch>                 prints "<tree> <head>"
#   intent-git.sh verify   <task_id> <branch_slug> <base_branch> <tree> <head> [validator|reviewer]
#       Tamper guard for agents whose tool denies are not enforced (bypassPermissions under copilot):
#       snapshot fingerprints the working tree before the agent runs; verify exits 1 (and records
#       status=escalated + verdicts.<role>=MODIFIED_FILES|GUARD_ERROR) if HEAD moved or any
#       non-ignored file changed since. Paths listed in scripts/intent-guard-ignore at <head> (one
#       pathspec per line, # comments) are left out of the fingerprint. Nothing is stored in the repo:
#       the workflow carries "<tree> <head>" in the snapshot task's output and runs both steps from
#       the committed copy of this script (git show <head>:scripts/intent-git.sh), so an agent cannot
#       forge the snapshot or patch the checker.
# Prints one result line on stdout; exits non-zero on failure (after recording status=failed).
set -uo pipefail

# Agent hosts (e.g. Copilot CLI) export GIT_CONFIG_COUNT/KEY_n/VALUE_n; nested processes can inherit
# them half-stripped, which makes every git call fail with "missing config key GIT_CONFIG_KEY_0".
for v in $(env | grep -oE '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)='); do unset "${v%=}"; done

cmd=${1:-}; task_id=${2:-}; slug=${3:-}; base=${4:-}
if [ -z "$cmd" ] || [ -z "$task_id" ] || [ -z "$slug" ] || [ -z "$base" ]; then
  echo "usage: intent-git.sh branch|merge|snapshot|verify <task_id> <branch_slug> <base_branch> (all required)" >&2
  exit 2
fi
feature="feature/$slug"
state=scripts/task-state.js
excl=(':(exclude).task-state' ':(exclude)scripts/task-state.js' ':(exclude).copilot-cache')

st() { "$state" set "$task_id" "$@" >/dev/null 2>&1 || true; }
fail() { st "phase=$1" status=failed "feedback.engine=$2: $3"; echo "$2 $3"; exit 1; }
has_origin() { git remote get-url origin >/dev/null 2>&1; }

# Tree hash of the whole working tree (tracked + untracked, honouring .gitignore and info/exclude),
# built in a throwaway index so the real index is never touched. $1 = commit to read the ignore list from.
tree_fingerprint() {
  mkdir -p .task-state || return 1
  local idx=".task-state/guard-idx.$$" rc=0 t="" p l
  local -a ign=()
  while IFS= read -r l || [ -n "$l" ]; do
    l=${l%%#*}; l=$(printf %s "$l" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "$l" ] && ign+=("$l")
  done < <(git show "$1:scripts/intent-guard-ignore" 2>/dev/null)
  rm -f "$idx"
  GIT_INDEX_FILE=$idx git read-tree HEAD && GIT_INDEX_FILE=$idx git add -A -- . || rc=1
  if [ $rc -eq 0 ]; then
    for p in .task-state scripts/task-state.js .copilot-cache ${ign[@]+"${ign[@]}"}; do
      GIT_INDEX_FILE=$idx git rm -r -q --cached --ignore-unmatch -- "$p" >/dev/null || { rc=1; break; }
    done
  fi
  [ $rc -eq 0 ] && { t=$(GIT_INDEX_FILE=$idx git write-tree) || rc=1; }
  rm -f "$idx"
  [ $rc -eq 0 ] && printf '%s\n' "$t"
  return $rc
}

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
  # feedback (incl. feedback.engine from a crashed attempt) is left for the implementer, who clears it when done.
  st phase=branched status=in_progress "branch=$feature"
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
  if [ -n "$bad" ]; then
    git reset -q
    fail merging MERGE=ABORTED_SENSITIVE_FILES "${bad}- implementer: delete these files or add them to .gitignore (never commit secrets, keys, logs, databases, dependencies or build output)"
  fi
  if ! git diff --cached --quiet; then
    git commit -q -m "feat($slug): implement intent $task_id" || fail merging MERGE=FAILED commit
  fi
  [ "$(git rev-list --count "$base..$feature")" -gt 0 ] || fail merging MERGE=FAILED nothing-to-merge
  pushed=no
  if has_origin; then git push -q -u origin "$feature" || fail merging MERGE=FAILED push-feature; pushed=yes; fi
  git checkout -q "$base" || fail merging MERGE=FAILED "checkout:$base"
  if ! git merge -q --no-ff "$feature" -m "Merge $feature"; then
    git merge --abort 2>/dev/null; git checkout -q "$feature"
    # A retry cannot fix this (agents may not merge/rebase): park it for a human; `next` skips needs_human.
    st phase=merging status=needs_human "feedback.engine=MERGE=CONFLICT $feature->$base: resolve manually (work is committed on $feature)"
    echo "MERGE=CONFLICT $feature->$base"; exit 1
  fi
  sha=$(git rev-parse HEAD)
  if has_origin; then git push -q origin "$base" || fail merging MERGE=FAILED "push:$base"; fi
  deleted=no
  git branch -q -d "$feature" && deleted=yes
  [ "$pushed" = yes ] && { git push -q origin --delete "$feature" 2>/dev/null || true; }
  st phase=completed status=completed "commit=$sha"
  echo "COMMIT=$sha MERGE=OK BRANCH_DELETED=$deleted"
  ;;
snapshot)
  [ "$(git branch --show-current)" = "$feature" ] || fail validating GUARD=FAILED "not-on:$feature"
  h=$(git rev-parse HEAD) || fail validating GUARD=FAILED rev-parse
  t=$(tree_fingerprint "$h") && [ -n "$t" ] || fail validating GUARD=FAILED snapshot
  echo "$t $h"
  ;;
verify)
  before=${5:-}; head_before=${6:-}; role=${7:-validator}
  case "$role" in
    validator) ph=validated; tok=PASS ;;
    reviewer)  ph=reviewed;  tok=CLEAR ;;
    *) echo "verify: unknown role $role" >&2; exit 2 ;;
  esac
  guard_err() { st status=escalated "phase=$ph" "verdicts.$role=GUARD_ERROR" "feedback.$role=tamper guard: $1"; echo "GUARD=ERROR $1"; exit 1; }
  [ -n "$before" ] && [ -n "$head_before" ] || guard_err "no snapshot to compare against"
  head_now=$(git rev-parse HEAD 2>/dev/null)
  if [ "$head_now" != "$head_before" ] || [ "$(git branch --show-current)" != "$feature" ]; then
    st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The $role reported $tok but moved HEAD or switched branches while it ran (now $(git branch --show-current)@$head_now, expected $feature@$head_before), so the $tok was rejected."
    echo "GUARD=HEAD_MOVED"; exit 1
  fi
  after=$(tree_fingerprint "$head_before") && [ -n "$after" ] || guard_err "could not fingerprint the tree"
  if [ "$before" != "$after" ]; then
    changed=$(git diff-tree -r --name-status "$before" "$after" | tr '\t' ' ' | paste -sd ';' -)
    st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The $role reported $tok but modified files while it ran (it must not change code), so the $tok was rejected. Changed: $changed. Review these changes; keep them only if they belong to the intent."
    echo "GUARD=MODIFIED $changed"
    exit 1
  fi
  echo "GUARD=UNCHANGED"
  ;;
*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
