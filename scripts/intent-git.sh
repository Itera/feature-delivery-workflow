#!/usr/bin/env bash
# Deterministic git steps for the intent-to-merge workflow (run from the repo root).
#   intent-git.sh branch <task_id> <branch_slug> <base_branch>   create/reuse feature/<slug>, reset verdicts
#       (first aborts any merge/rebase/cherry-pick/revert left in progress by an interrupted run and
#        stops processes recorded in .task-state/pids-* that are still running, see kill_recorded)
#   intent-git.sh cleanup <task_id> <branch_slug> <base_branch>  stop processes in .task-state/pids-<task_id>
#   intent-git.sh merge  <task_id> <branch_slug> <base_branch>   commit, merge --no-ff into base, delete branch
#   intent-git.sh snapshot <task_id> <branch_slug> <base_branch> [role]          prints "<tree> <head>"
#   intent-git.sh verify   <task_id> <branch_slug> <base_branch> <tree> <head> [validator|reviewer|test_author]
#       Tamper guard for agents whose tool denies are not enforced (bypassPermissions under copilot):
#       snapshot fingerprints the working tree before the agent runs; verify exits 1 (and records
#       status=escalated + verdicts.<role>=MODIFIED_FILES|GUARD_ERROR) if HEAD moved or any
#       non-ignored file changed since. Paths listed in scripts/intent-guard-ignore at <head> (one
#       pathspec per line, # comments) are left out of the fingerprint. Nothing is stored in the repo:
#       the workflow carries "<tree> <head>" in the snapshot task's output and runs both steps from
#       the committed copy of this script (git show <head>:scripts/intent-git.sh), so an agent cannot
#       forge the snapshot or patch the checker.
#   For role test_author the acceptance tests ($ACCEPT) are left out of the fingerprint: the test author
#   may write exactly those files and nothing else.
#   intent-git.sh lock-tests <task_id> <slug> <base> <tree> <head> <attempt>
#       After the test author: verify it changed only acceptance tests and wrote/kept some for this
#       intent, then print a hash of all acceptance tests (the workflow keeps it in the task output).
#   intent-git.sh run-tests <task_id> <slug> <base> <attempt> <test_command>
#       Deterministic test gate: run <test_command> from the repo root if the implementer finished,
#       log to .task-state/test-<task_id>.log, record verdicts.tester, print GREEN|TEST_FAIL|NOT_RUN.
#   intent-git.sh check-tests <task_id> <slug> <base> <lock_hash> <run_result>
#       Exit 1 (recording verdicts.tester=MODIFIED_TESTS) if the acceptance tests changed since lock-tests.
# Prints one result line on stdout; exits non-zero on failure (after recording status=failed).
set -uo pipefail

# Agent hosts (e.g. Copilot CLI) export GIT_CONFIG_COUNT/KEY_n/VALUE_n; nested processes can inherit
# them half-stripped, which makes every git call fail with "missing config key GIT_CONFIG_KEY_0".
for v in $(env | grep -oE '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)='); do unset "${v%=}"; done

cmd=${1:-}; task_id=${2:-}; slug=${3:-}; base=${4:-}
if [ -z "$cmd" ] || [ -z "$task_id" ] || [ -z "$slug" ] || [ -z "$base" ]; then
  echo "usage: intent-git.sh branch|merge|snapshot|verify|cleanup|lock-tests|run-tests|check-tests <task_id> <branch_slug> <base_branch> (all required)" >&2
  exit 2
fi
feature="feature/$slug"
state=scripts/task-state.js
excl=(':(exclude).task-state' ':(exclude)scripts/task-state.js' ':(exclude).copilot-cache' ':(exclude).digital-factory' ':(exclude).digital-factory-outputs')
# Acceptance tests written by the test author from the intent's Success Metrics (locked for the implementer).
ACCEPT=':(glob)**/*.acceptance.test.*' 

st() { "$state" set "$task_id" "$@" >/dev/null 2>&1 || true; }
fail() { st "phase=$1" status=failed "feedback.engine=$2: $3"; echo "$2 $3"; exit 1; }
has_origin() { git remote get-url origin >/dev/null 2>&1; }

# Tree hash of the whole working tree (tracked + untracked, honouring .gitignore and info/exclude),
# built in a throwaway index so the real index is never touched. $1 = commit to read the ignore list from;
# further args = extra pathspecs to leave out.
tree_fingerprint() {
  mkdir -p .task-state || return 1
  local idx=".task-state/guard-idx.$$" rc=0 t="" p l rev=$1
  shift
  local -a ign=("$@")
  while IFS= read -r l || [ -n "$l" ]; do
    l=${l%%#*}; l=$(printf %s "$l" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "$l" ] && ign+=("$l")
  done < <(git show "$rev:scripts/intent-guard-ignore" 2>/dev/null)
  rm -f "$idx"
  GIT_INDEX_FILE=$idx git read-tree HEAD && GIT_INDEX_FILE=$idx git add -A -- . || rc=1
  if [ $rc -eq 0 ]; then
    for p in .task-state scripts/task-state.js .copilot-cache .digital-factory .digital-factory-outputs ${ign[@]+"${ign[@]}"}; do
      GIT_INDEX_FILE=$idx git rm -r -q --cached --ignore-unmatch -- "$p" >/dev/null || { rc=1; break; }
    done
  fi
  [ $rc -eq 0 ] && { t=$(GIT_INDEX_FILE=$idx git write-tree) || rc=1; }
  rm -f "$idx"
  [ $rc -eq 0 ] && printf '%s\n' "$t"
  return $rc
}

# Stop processes an agent recorded in .task-state/pids-* (one PID per line) and left running, e.g. dev
# servers after a validator crash. A PID is only killed if its working directory is inside this repo and
# it is not an ancestor of this script (the engine/orchestrator also run here). $1 = file glob.
proc_cwd() {
  if [ -r "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd"
  else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; fi
}
kill_recorded() {
  local root f pid c anc="" a=$$ n=0 i
  root=$(pwd -P)
  while [ -n "$a" ] && [ "$a" -gt 1 ] 2>/dev/null; do anc="$anc $a "; a=$(ps -o ppid= -p "$a" 2>/dev/null | tr -d ' '); done
  for f in $1; do
    [ -f "$f" ] || continue
    while IFS= read -r pid || [ -n "$pid" ]; do
      pid=$(printf %s "$pid" | tr -cd 0-9)
      [ -n "$pid" ] && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null || continue
      case "$anc" in *" $pid "*) continue ;; esac
      c=$(proc_cwd "$pid")
      case "$c/" in "$root"/*) ;; *) continue ;; esac
      kill "$pid" 2>/dev/null && n=$((n + 1))
      for i in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    done < "$f"
    rm -f "$f"
  done
  [ "$n" -gt 0 ] && echo "CLEANUP: stopped $n leftover process(es)" >&2
  return 0
}

# Hash over "<path> <blob>" of every acceptance test in the working tree (tracked or untracked, not
# ignored). Prints nothing and returns 1 if there are none.
accept_hash() {
  local f list=""
  while IFS= read -r f; do
    if [ -f "$f" ]; then list+="$f $(git hash-object -- "$f")"$'\n'; else list+="$f deleted"$'\n'; fi
  done < <(git ls-files -co --exclude-standard -- "$ACCEPT" | sort -u)
  [ -n "$list" ] || return 1
  printf %s "$list" | git hash-object --stdin
}
role_exclude() { [ "$1" = test_author ] && printf '%s' "$ACCEPT"; }

# Tamper guard comparison shared by verify and lock-tests. Args: before head_before role.
do_verify() {
  local before=$1 head_before=$2 role=$3 ph tok head_now after changed ex
  case "$role" in
    validator)   ph=validated;     tok=PASS ;;
    reviewer)    ph=reviewed;      tok=CLEAR ;;
    test_author) ph=tests_written; tok=DONE ;;
    *) echo "verify: unknown role $role" >&2; exit 2 ;;
  esac
  guard_err() { st status=escalated "phase=$ph" "verdicts.$role=GUARD_ERROR" "feedback.$role=tamper guard: $1"; echo "GUARD=ERROR $1"; exit 1; }
  [ -n "$before" ] && [ -n "$head_before" ] || guard_err "no snapshot to compare against"
  head_now=$(git rev-parse HEAD 2>/dev/null)
  if [ "$head_now" != "$head_before" ] || [ "$(git branch --show-current)" != "$feature" ]; then
    st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The $role reported $tok but moved HEAD or switched branches while it ran (now $(git branch --show-current)@$head_now, expected $feature@$head_before), so the $tok was rejected."
    echo "GUARD=HEAD_MOVED"; exit 1
  fi
  ex=$(role_exclude "$role")
  after=$(tree_fingerprint "$head_before" ${ex:+"$ex"}) && [ -n "$after" ] || guard_err "could not fingerprint the tree"
  if [ "$before" != "$after" ]; then
    changed=$(git diff-tree -r --name-status "$before" "$after" | tr '\t' ' ' | paste -sd ';' -)
    if [ "$role" = test_author ]; then
      st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The test author may only write *.acceptance.test.* files but changed other files, so its tests were not accepted. Changed: $changed. Put helpers inside the acceptance test files and leave everything else untouched."
    else
      st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The $role reported $tok but modified files while it ran (it must not change code), so the $tok was rejected. Changed: $changed. Review these changes; keep them only if they belong to the intent."
    fi
    echo "GUARD=MODIFIED $changed"
    exit 1
  fi
}

case "$cmd" in
branch)
  st phase=branched status=in_progress
  kill_recorded '.task-state/pids-*'
  # Recover from a run killed mid-operation (e.g. inside `merge`): abort it so the repo is usable again.
  gd=$(git rev-parse --git-dir) || fail branched BRANCH=FAILED no-git-dir
  for op in merge:MERGE_HEAD rebase:rebase-merge rebase:rebase-apply cherry-pick:CHERRY_PICK_HEAD revert:REVERT_HEAD; do
    if [ -e "$gd/${op#*:}" ]; then
      git "${op%%:*}" --abort >/dev/null 2>&1 || fail branched BRANCH=FAILED "cannot-abort-${op%%:*}"
      echo "RECOVERED: aborted interrupted ${op%%:*}" >&2
    fi
  done
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
  for p in .task-state scripts/task-state.js .copilot-cache .digital-factory .digital-factory-outputs; do git reset -q -- "$p" 2>/dev/null || true; done
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
  ex=$(role_exclude "${5:-}")
  t=$(tree_fingerprint "$h" ${ex:+"$ex"}) && [ -n "$t" ] || fail validating GUARD=FAILED snapshot
  echo "$t $h"
  ;;
verify)
  do_verify "${5:-}" "${6:-}" "${7:-validator}"
  echo "GUARD=UNCHANGED"
  ;;
lock-tests)
  attempt=${7:-}
  v=$("$state" get "$task_id" verdicts.test_author 2>/dev/null); a=$("$state" get "$task_id" verdicts.test_author_attempt 2>/dev/null)
  [ "$v" = DONE ] && [ "$a" = "$attempt" ] || { echo "LOCK=NO test author verdict '$v' (attempt '$a', expected DONE/$attempt)" >&2; exit 1; }
  do_verify "${5:-}" "${6:-}" test_author >&2
  mine=$( { git diff --name-only "$base" -- "$ACCEPT"; git ls-files -o --exclude-standard -- "$ACCEPT"; } | sort -u)
  if [ -z "$mine" ]; then
    st status=escalated phase=tests_written verdicts.test_author=NO_TESTS "feedback.test_author=No *.acceptance.test.* file was added or changed for this intent (compared with $base). Write acceptance tests for the Success Metrics."
    echo "LOCK=NO_TESTS" >&2; exit 1
  fi
  h=$(accept_hash) || { echo "LOCK=NO_HASH" >&2; exit 1; }
  st phase=tests_written status=in_progress
  printf %s "$h"
  ;;
run-tests)
  attempt=${5:-}; tcmd=${6:-}
  [ -n "$tcmd" ] || { printf NOT_RUN; echo "run-tests: empty test_command" >&2; exit 1; }
  [ "$(git branch --show-current)" = "$feature" ] || { printf NOT_RUN; echo "run-tests: not on $feature" >&2; exit 1; }
  v=$("$state" get "$task_id" verdicts.implementer 2>/dev/null); a=$("$state" get "$task_id" verdicts.implementer_attempt 2>/dev/null)
  [ "$v" = DONE ] && [ "$a" = "$attempt" ] || { printf NOT_RUN; echo "run-tests: implementer verdict '$v' (attempt '$a')" >&2; exit 0; }
  st phase=testing status=in_progress
  log=.task-state/test-$task_id.log
  mkdir -p .task-state
  { echo "\$ $tcmd"; sh -c "$tcmd" </dev/null; } >"$log" 2>&1; rc=$?
  why=""
  if [ $rc -ne 0 ]; then why="exit code $rc"
  elif grep -Eq '^(ℹ|#) tests 0$' "$log"; then why="the test runner executed 0 tests"
  fi
  if [ -z "$why" ]; then
    st phase=tested status=in_progress verdicts.tester=GREEN "verdicts.tester_attempt=$attempt" feedback.tester=
    printf GREEN
  else
    # Fallback feedback; the summariser agent replaces it with a curated one.
    st phase=tested status=escalated verdicts.tester=TEST_FAIL "verdicts.tester_attempt=$attempt" \
      "feedback.tester=\`$tcmd\` failed ($why). Last lines of the log: $(tail -n 30 "$log")"
    printf TEST_FAIL
  fi
  ;;
check-tests)
  lock=${5:-}; res=${6:-}
  [ -n "$lock" ] || { echo "CHECK=NO_LOCK" >&2; exit 1; }
  now=$(accept_hash)
  if [ "$now" != "$lock" ]; then
    files=$( { git diff --name-only "$base" -- "$ACCEPT"; git ls-files -o --exclude-standard -- "$ACCEPT"; } | sort -u | paste -sd ' ' -)
    st status=escalated phase=tested verdicts.tester=MODIFIED_TESTS "feedback.tester=The implementer changed, added, renamed or deleted *.acceptance.test.* files after they were locked (acceptance tests: $files). The implementer must never touch them: make the tests pass by implementing the behaviour, or record TEST_DISPUTE. Test author: restore your tests."
    echo "CHECK=MODIFIED_TESTS" >&2; exit 1
  fi
  # The engine-held run result is authoritative; never let a GREEN in the state file outlive a failed run.
  if [ "$res" != GREEN ] && [ "$("$state" get "$task_id" verdicts.tester 2>/dev/null)" = GREEN ]; then
    st verdicts.tester=TEST_FAIL status=escalated
  fi
  echo "CHECK=OK"
  ;;
cleanup)
  kill_recorded ".task-state/pids-$task_id"
  echo "CLEANUP=OK"
  ;;
*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
