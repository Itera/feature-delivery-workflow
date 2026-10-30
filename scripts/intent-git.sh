#!/usr/bin/env bash
# Deterministic git steps for the sdlc workflow (run from the repo root).
#   intent-git.sh branch <task_id> <branch_slug> <base_branch>   create/reuse feature/<slug>, reset verdicts
#       (first aborts any merge/rebase/cherry-pick/revert left in progress by an interrupted run and
#        stops processes recorded in .task-state/pids-* that are still running, see kill_recorded)
#   intent-git.sh park   <task_id> <branch_slug> <base_branch>   WIP-commit an exhausted intent (sensitive files -> stash)
#   intent-git.sh cleanup <task_id> <branch_slug> <base_branch>  stop processes in .task-state/pids-<task_id>
#   intent-git.sh merge  <task_id> <branch_slug> <base_branch>   commit, merge --no-ff into base, delete branch
#   intent-git.sh snapshot <task_id> <branch_slug> <base_branch> [role]   prints "<tree> <head> <trust> <state_hash> <git_meta>"
#   intent-git.sh git-meta <task_id> <branch_slug> <base_branch>   prints the git metadata hash (see git_meta_hash)
#   intent-git.sh verify   <task_id> <branch_slug> <base_branch> <tree> <head> [validator|reviewer|test_author]
#       Tamper guard for agents whose tool denies are not enforced (bypassPermissions under copilot):
#       snapshot fingerprints the working tree before the agent runs; verify exits 1 (and records
#       status=escalated + verdicts.<role>=MODIFIED_FILES|GUARD_ERROR) if HEAD moved or any
#       non-ignored file changed since. Paths listed in .intent-loop/scripts/intent-guard-ignore at <head> (one
#       pathspec per line, # comments) are left out of the fingerprint. Nothing is stored in the repo:
#       the workflow carries "<tree> <head>" in the snapshot task's output and runs both steps from
#       the committed copy of this script (git show <head>:.intent-loop/scripts/intent-git.sh), so an agent cannot
#       forge the snapshot or patch the checker.
#   For role test_author the acceptance tests ($ACCEPT) are left out of the fingerprint: the test author
#   may write exactly those files and nothing else.
#   intent-git.sh lock-tests <task_id> <slug> <base> <tree> <head> <attempt>
#       After the test author: verify it changed only acceptance tests and wrote/kept some for this
#       intent, then print a hash of all acceptance tests (the workflow keeps it in the task output).
#   intent-git.sh run-tests <task_id> <slug> <base> <attempt> <test_command>
#       Deterministic test gate: run <test_command> from the repo root if the implementer finished,
#       log to .task-state/test-<task_id>.log, record verdicts.tester, print GREEN|TEST_FAIL|NOT_RUN.
#   intent-git.sh check-tests <task_id> <slug> <base> "<accept_hash> <setup_hash>" <run_result>
#       Exit 1 (recording verdicts.tester=MODIFIED_TESTS|MODIFIED_TEST_SETUP) if the acceptance tests or
#       the test setup (package.json test scripts, test runner config) changed since lock-tests.
#   intent-git.sh gate <task_id> <slug> <base> reviewer|validator <attempt> <tree> <head>
#       Print the role's verdict for this attempt; a passing verdict only if the tamper guard is clean.
# Trust: the workflow resolves the base commit once, before any agent runs (snapshot-before-tests, field
# <trust>), and runs every later step with INTENT_TRUST=<trust>: this script comes from that commit, and so
# do task-state.js (when tracked; otherwise its hash must equal INTENT_STATE_HASH) and the guard's ignore
# list. Changes to the loop's own files ($PROTECTED) on the branch fail the run, and merge refuses if the
# base branch moved during the run.
# Git metadata: hooks and git config can make our own git commands run code (hooks, core.fsmonitor, filter
# drivers, ...), outside every check above. Their hash (<git_meta>) is taken before any agent runs (passed in
# by the orchestrator as INTENT_META, else computed by the first snapshot); every later command re-checks it
# before running git and, on a mismatch, sets status=needs_human (feedback.engine=GIT_META_CHANGED) and exits 1.
# Prints one result line on stdout; exits non-zero on failure (after recording status=failed).
set -uo pipefail

# Agent hosts (e.g. Copilot CLI) export GIT_CONFIG_COUNT/KEY_n/VALUE_n; nested processes can inherit
# them half-stripped, which makes every git call fail with "missing config key GIT_CONFIG_KEY_0".
for v in $(env | grep -oE '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)='); do unset "${v%=}"; done

cmd=${1:-}; task_id=${2:-}; slug=${3:-}; base=${4:-}
if [ -z "$cmd" ] || [ -z "$task_id" ] || [ -z "$slug" ] || [ -z "$base" ]; then
  echo "usage: intent-git.sh branch|merge|park|snapshot|git-meta|verify|gate|cleanup|lock-tests|run-tests|check-tests <task_id> <branch_slug> <base_branch> (all required)" >&2
  exit 2
fi
feature="feature/$slug"
state=.intent-loop/scripts/task-state.js
excl=(':(exclude).task-state' ':(exclude).intent-loop/scripts/task-state.js' ':(exclude).copilot-cache' ':(exclude).digital-factory' ':(exclude).digital-factory-outputs')
# Acceptance tests written by the test author from the intent's Success Metrics (locked for the implementer).
ACCEPT=':(glob)**/*.acceptance.test.*'
# Test setup locked together with the acceptance tests: (pre|post)test* scripts of every package.json and
# test runner config files. The implementer cannot make the acceptance tests skip by changing these.
SETUP_CFG=(':(glob)**/vitest.config.*' ':(glob)**/vitest.workspace.*' ':(glob)**/jest.config.*' ':(glob)**/.mocharc*'
  ':(glob)**/playwright.config.*' ':(glob)**/karma.conf.*' ':(glob)**/ava.config.*' ':(glob)**/.nycrc*' ':(glob)**/.c8rc*'
  ':(glob)**/pytest.ini' ':(glob)**/conftest.py')
# The loop's own files: an intent must never change them (they decide whether its work is accepted).
PROTECTED=(.intent-loop .claude/skills/intent-orchestrator)
TRUST=${INTENT_TRUST:-}
STATE_HASH=${INTENT_STATE_HASH:-}
META=${INTENT_META:-}

# Run task-state.js: the committed copy at $TRUST when it is tracked there, else the working copy, which
# must then be unchanged since the run started (an agent could otherwise forge verdicts through it).
ts() {
  if [ -n "$TRUST" ] && git cat-file -e "$TRUST:$state" 2>/dev/null; then
    git show "$TRUST:$state" | node - "$@"; return
  fi
  if [ -n "$STATE_HASH" ] && [ "$STATE_HASH" != - ] && [ "$(git hash-object -- "$state" 2>/dev/null)" != "$STATE_HASH" ]; then
    echo "TAMPERED: $state changed during the run; refusing to use it" >&2; return 3
  fi
  "$state" "$@"
}
st() { ts set "$task_id" "$@" >/dev/null 2>&1 || true; }
fail() { st "phase=$1" status=failed "feedback.engine=$2: $3"; echo "$2 $3"; exit 1; }
has_origin() { git remote get-url origin >/dev/null 2>&1; }

# Hash of what lives outside the working tree but makes git run code or changes what git sees: config of
# every scope (hooksPath, fsmonitor, filter/diff drivers, aliases, ...; branch.* is left out, `push -u` and
# `branch -d` rewrite it), the hooks dirs (default and core.hooksPath: content and executable bit) and
# info/attributes + info/exclude. Reads files only; runs no hook, filter or fsmonitor.
git_meta_hash() {
  local gd hp d f
  gd=$(git rev-parse --git-common-dir) && hp=$(git rev-parse --git-path hooks) || return 1
  {
    git config --list --show-scope --show-origin --includes 2>/dev/null | awk -F'\t' '$3 !~ /^branch\./'
    for d in "$gd/hooks" "$hp"; do
      [ -d "$d" ] || continue
      find -L "$d" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
        printf '== %s %s\n' "$f" "$([ -x "$f" ] && echo x || echo -)"; cat "$f" 2>/dev/null
      done
    done
    for f in "$gd/info/attributes" "$gd/info/exclude"; do [ -f "$f" ] && { printf '== %s\n' "$f"; cat "$f"; }; done
  } | git hash-object --no-filters --stdin
}

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
  done < <(git show "${TRUST:-$rev}:.intent-loop/scripts/intent-guard-ignore" 2>/dev/null)
  rm -f "$idx"
  GIT_INDEX_FILE=$idx git read-tree HEAD && GIT_INDEX_FILE=$idx git add -A -- . || rc=1
  if [ $rc -eq 0 ]; then
    for p in .task-state .intent-loop/scripts/task-state.js .copilot-cache .digital-factory .digital-factory-outputs ${ign[@]+"${ign[@]}"}; do
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
# Hash over the test setup (see SETUP_CFG); always prints a hash.
setup_hash() {
  local f list=""
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    list+="$f $(node -e 'let o={};try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).scripts||{};for(const k of Object.keys(s).sort())if(/^(pre|post)?test($|:)/.test(k))o[k]=s[k]}catch(e){o="unparsable"}process.stdout.write(JSON.stringify(o))' "$f")"$'\n'
  done < <(git ls-files -co --exclude-standard -- ':(glob)**/package.json' | sort -u)
  while IFS= read -r f; do
    if [ -f "$f" ]; then list+="$f $(git hash-object -- "$f")"$'\n'; fi
  done < <(git ls-files -co --exclude-standard -- "${SETUP_CFG[@]}" | sort -u)
  printf %s "$list" | git hash-object --stdin
}
# Protected loop files changed vs $TRUST (committed, uncommitted or untracked); prints them space-separated.
protected_changes() {
  [ -n "$TRUST" ] || return 0
  local -a p=("${PROTECTED[@]}")
  git cat-file -e "$TRUST:$state" 2>/dev/null && p+=("$state")
  { git diff --name-only "$TRUST" -- "${p[@]}"; git ls-files -o --exclude-standard -- "${p[@]}"; } | sort -u | paste -sd ' ' -
}
# Unstage the orchestrator's own files after `git add -A` (exclude pathspecs in `git add` exit 1 when
# the excluded path is also gitignored).
unstage_internal() {
  local p
  for p in .task-state .intent-loop/scripts/task-state.js .copilot-cache .digital-factory .digital-factory-outputs; do git reset -q -- "$p" 2>/dev/null || true; done
}
# Staged files that must never be committed (secrets, keys, logs, databases, dependencies, build output).
sensitive_staged() {
  git diff --cached --name-only \
    | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|(^|/)id_rsa|(^|/)node_modules/|\.log$|(^|/)dist/|(^|/)build/|\.db$' \
    | grep -vE '(^|/)\.env\.example$'
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
git-meta) git_meta_hash; exit ;;
snapshot|branch|park) ;;
*) [ -n "$TRUST" ] && [ -z "$META" ] && { echo "GIT_META=MISSING: no INTENT_META baseline for $cmd" >&2; exit 1; } ;;
esac
# Before any other git command (a planted hook or config could run code inside them).
if [ -n "$META" ]; then
  now_meta=$(git_meta_hash)
  if [ "$now_meta" != "$META" ]; then
    st status=needs_human "feedback.engine=GIT_META_CHANGED: git hooks or git config changed during the run (before $cmd). They can make git run arbitrary code, so the run was stopped and nothing more was executed. Inspect .git/hooks, core.hooksPath, .git/info/ and 'git config --list --show-origin', revert anything unexpected, then retry with status=pending attempts=0."
    echo "GIT_META=CHANGED (before $cmd)" >&2
    exit 1
  fi
fi

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
  ts set "$task_id" 'verdicts={}' >/dev/null || fail branched BRANCH=FAILED state-reset
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
  if [ -n "$TRUST" ] && [ "$(git rev-parse "$base")" != "$TRUST" ]; then
    st phase=merging status=needs_human "feedback.engine=MERGE=BASE_MOVED $base moved during the run (was $TRUST, now $(git rev-parse --short "$base")); something other than this run committed to it. Check $base, then retry with status=pending attempts=0."
    echo "MERGE=BASE_MOVED"; exit 1
  fi
  pc=$(protected_changes)
  [ -z "$pc" ] || fail merging MERGE=ABORTED_PROTECTED_FILES "$pc - implementer: revert these files to $base (git checkout $base -- <file>, delete new ones); intents must not change the dev loop itself"
  # Add everything, then unstage the orchestrator's own files. (Exclude pathspecs in `git add` exit 1
  # when the excluded path is also gitignored.)
  git add -A -- . || fail merging MERGE=FAILED git-add
  unstage_internal
  bad=$(sensitive_staged | tr '\n' ' ')
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
  tr=${TRUST:-$(git rev-parse "$base")} || fail validating GUARD=FAILED rev-parse-base
  sth=${STATE_HASH:-$(git hash-object -- "$state" 2>/dev/null || echo -)}
  mh=${META:-$(git_meta_hash)} && [ -n "$mh" ] || fail validating GUARD=FAILED git-meta
  echo "$t $h $tr $sth $mh"
  ;;
verify)
  do_verify "${5:-}" "${6:-}" "${7:-validator}"
  echo "GUARD=UNCHANGED"
  ;;
lock-tests)
  attempt=${7:-}
  v=$(ts get "$task_id" verdicts.test_author 2>/dev/null); a=$(ts get "$task_id" verdicts.test_author_attempt 2>/dev/null)
  [ "$v" = DONE ] && [ "$a" = "$attempt" ] || { echo "LOCK=NO test author verdict '$v' (attempt '$a', expected DONE/$attempt)" >&2; exit 1; }
  do_verify "${5:-}" "${6:-}" test_author >&2
  mine=$( { git diff --name-only "$base" -- "$ACCEPT"; git ls-files -o --exclude-standard -- "$ACCEPT"; } | sort -u)
  if [ -z "$mine" ]; then
    st status=escalated phase=tests_written verdicts.test_author=NO_TESTS "feedback.test_author=No *.acceptance.test.* file was added or changed for this intent (compared with $base). Write acceptance tests for the Success Metrics."
    echo "LOCK=NO_TESTS" >&2; exit 1
  fi
  h=$(accept_hash) || { echo "LOCK=NO_HASH" >&2; exit 1; }
  su=$(setup_hash) || { echo "LOCK=NO_SETUP_HASH" >&2; exit 1; }
  st phase=tests_written status=in_progress
  printf '%s %s' "$h" "$su"
  ;;
run-tests)
  attempt=${5:-}; tcmd=${6:-}
  [ -n "$tcmd" ] || { printf NOT_RUN; echo "run-tests: empty test_command" >&2; exit 1; }
  [ "$(git branch --show-current)" = "$feature" ] || { printf NOT_RUN; echo "run-tests: not on $feature" >&2; exit 1; }
  v=$(ts get "$task_id" verdicts.implementer 2>/dev/null); a=$(ts get "$task_id" verdicts.implementer_attempt 2>/dev/null)
  [ "$v" = DONE ] && [ "$a" = "$attempt" ] || { printf NOT_RUN; echo "run-tests: implementer verdict '$v' (attempt '$a')" >&2; exit 0; }
  pc=$(protected_changes)
  if [ -n "$pc" ]; then
    st phase=tested status=escalated verdicts.tester=MODIFIED_PROTECTED "verdicts.tester_attempt=$attempt" "feedback.tester=These files belong to the dev loop and must not be changed by an intent: $pc. Implementer: revert them to $base (git checkout $base -- <file>; delete new files)."
    printf PROTECTED; echo "run-tests: protected files changed: $pc" >&2; exit 0
  fi
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
  read -r lock lock_setup <<<"${5:-}"; res=${6:-}
  [ -n "$lock" ] && [ -n "$lock_setup" ] || { echo "CHECK=NO_LOCK" >&2; exit 1; }
  now=$(accept_hash)
  if [ "$now" != "$lock" ]; then
    files=$( { git diff --name-only "$base" -- "$ACCEPT"; git ls-files -o --exclude-standard -- "$ACCEPT"; } | sort -u | paste -sd ' ' -)
    st status=escalated phase=tested verdicts.tester=MODIFIED_TESTS "feedback.tester=The implementer changed, added, renamed or deleted *.acceptance.test.* files after they were locked (acceptance tests: $files). The implementer must never touch them: make the tests pass by implementing the behaviour, or record TEST_DISPUTE. Test author: restore your tests."
    echo "CHECK=MODIFIED_TESTS" >&2; exit 1
  fi
  if [ "$(setup_hash)" != "$lock_setup" ]; then
    files=$( { git diff --name-only "${TRUST:-$base}" -- ':(glob)**/package.json' "${SETUP_CFG[@]}"; git ls-files -o --exclude-standard -- ':(glob)**/package.json' "${SETUP_CFG[@]}"; } | sort -u | paste -sd ' ' -)
    st status=escalated phase=tested verdicts.tester=MODIFIED_TEST_SETUP "feedback.tester=The implementer changed the test setup after the acceptance tests were locked: a (pre|post)test script in package.json or a test runner config file (candidates: $files). Implementer: revert those changes (other package.json edits such as dependencies are fine); the tests must run unchanged."
    echo "CHECK=MODIFIED_TEST_SETUP" >&2; exit 1
  fi
  # The engine-held run result is authoritative; never let a GREEN in the state file outlive a failed run.
  if [ "$res" != GREEN ] && [ "$(ts get "$task_id" verdicts.tester 2>/dev/null)" = GREEN ]; then
    st verdicts.tester=TEST_FAIL status=escalated
  fi
  echo "CHECK=OK"
  ;;
gate)
  role=${5:-}; attempt=${6:-}
  case "$role" in reviewer) pass=CLEAR ;; validator) pass=PASS ;; *) echo "gate: unknown role $role" >&2; exit 2 ;; esac
  v=$(ts get "$task_id" "verdicts.$role" 2>/dev/null); a=$(ts get "$task_id" "verdicts.${role}_attempt" 2>/dev/null)
  [ -n "$v" ] && [ "$a" = "$attempt" ] || { echo "GATE: no $role verdict for attempt $attempt ('$v', attempt '$a')" >&2; exit 1; }
  [ "$v" = "$pass" ] && { do_verify "${7:-}" "${8:-}" "$role" >&2; echo "GUARD=UNCHANGED" >&2; }
  [ "$(git branch --show-current)" = "$feature" ] || { echo "GATE: not on $feature" >&2; exit 1; }
  printf %s "$v"
  ;;
park)
  # Orchestrator, after the last failed attempt: commit the half-done work on the feature branch as WIP
  # and return to the base branch. Sensitive files are not committed; they go to a git stash instead.
  # Does not change the intent's status.
  [ "$(git branch --show-current)" = "$feature" ] || { echo "PARK=SKIPPED not on $feature"; exit 0; }
  git add -A -- . || { echo "PARK=FAILED git-add"; exit 1; }
  unstage_internal
  stashed=none; bad=()
  while IFS= read -r f; do [ -n "$f" ] && bad+=("$f"); done < <(sensitive_staged)
  if [ ${#bad[@]} -gt 0 ]; then
    git reset -q
    git stash push -q -u -m "intent $task_id: sensitive files kept out of the WIP commit" -- "${bad[@]}" || { echo "PARK=FAILED stash"; exit 1; }
    stashed=$(git rev-parse -q --verify refs/stash)
    git add -A -- . && unstage_internal
    [ -z "$(sensitive_staged)" ] || { git reset -q; echo "PARK=FAILED sensitive files still staged"; exit 1; }
  fi
  if ! git diff --cached --quiet; then
    git commit -q -m "WIP (unmerged, needs human): $task_id" || { echo "PARK=FAILED commit"; exit 1; }
  fi
  git checkout -q "$base" || { echo "PARK=FAILED checkout:$base (tree: $(git status --porcelain | head -3 | paste -sd ' ' -))"; exit 1; }
  echo "PARK=OK BRANCH=$feature STASH=$stashed${bad[*]:+ (kept out: ${bad[*]})}"
  ;;
cleanup)
  kill_recorded ".task-state/pids-$task_id"
  echo "CLEANUP=OK"
  ;;
*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
