#!/usr/bin/env bash
# Deterministic git steps and gates of the delivery workflow. Port of Peter's intent-git.sh (sdlc-workflow) for a
# factory that runs OUTSIDE the project (ADR-0001). Always started through scripts/launch.sh, from the factory commit
# $FACTORY_TRUST, with stdin closed:
#   story-git.sh <project> <run_dir> <repo> <cmd> <task_id> <branch> <base> [args...]
# <repo> is the project worktree (cwd for git); <run_dir> holds state.json, logs and scratch (never in the project);
# <base> is the story base branch (the branch the story was cut from and its PR targets).
#
# Commands (as in intent-git.sh unless noted):
#   preflight                     NEW. build + test on the untouched story base; records the baseline (red = not the story's fault)
#   branch                        verify the worktree is on <branch> (the driver creates it), recover interrupted git ops
#   snapshot [role]               prints "<tree> <head> <trust> <base_sha> <git_meta>"
#   verify <role> <tree> <head>   tamper guard
#   lock-tests <attempt> <tree> <head>
#   run-tests <attempt>           commands come from the trusted config, not from arguments
#   gate-test <run_result> <accept_hash> <setup_hash>   prints GREEN only if run-tests was GREEN and nothing locked changed
#   gate reviewer|validator <attempt> <tree> <head>
#   cleanup | park | git-meta | plan-hash <file>
#   publish <dry|draft-pr> <story_file> <story_hash>   NEW (replaces merge): commit explicit paths, isolation + disclosure checks, push, draft PR
# Snapshot fields always come last, so a task can pass ${tasks.<snapshot>.output?} whole (extra words are ignored).
#
# Trust: this script, task-state.js, the guard ignore list and the project config are read with
# `git -C $FACTORY_REPO show $FACTORY_TRUST:<path>`. Agents work in <repo> and cannot reach that commit.
# Git metadata of the project repo (hooks, config) is hashed before any agent runs and re-checked before every git call.
# Prints one result line on stdout; diagnostics on stderr.
set -uo pipefail
set +o posix 2>/dev/null || true

for v in $(env | grep -oE '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)='); do unset "${v%=}"; done

PROJECT=${1:-}; RUN=${2:-}; REPO=${3:-}; cmd=${4:-}; task_id=${5:-}; branch=${6:-}; base=${7:-}
shift 7 2>/dev/null || { echo "usage: story-git.sh <project> <run_dir> <repo> <cmd> <task_id> <branch> <base> [args...]" >&2; exit 2; }
F=${FACTORY_REPO:-}; TRUST=${FACTORY_TRUST:-}
[ -n "$F" ] && [ -n "$TRUST" ] || { echo "story-git.sh: start it through launch.sh (FACTORY_REPO/FACTORY_TRUST unset)" >&2; exit 2; }
cd "$REPO" || { echo "story-git.sh: no repo at $REPO" >&2; exit 1; }
mkdir -p "$RUN/tmp" "$RUN/logs" || exit 1
STATE_FILE=$RUN/state.json
META=${STORY_META:-}

# --- trusted inputs -------------------------------------------------------------------------------------------
fshow() { git -C "$F" show "$TRUST:$1"; }
ts() { fshow scripts/task-state.js | node - --state "$STATE_FILE" "$@"; }
st() { ts set "$task_id" "$@" >/dev/null 2>&1 || true; }
fail() { st "phase=$1" status=failed "feedback.engine=$2: $3"; echo "$2 $3"; exit 1; }
CFG_JSON=$(fshow "projects/$PROJECT/generated/config.json") || { echo "no trusted config for $PROJECT at $TRUST" >&2; exit 1; }
cfg() { printf %s "$CFG_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split("."))v=v==null?v:v[k];if(Array.isArray(v))v=v.join("\n");process.stdout.write(v==null?"":String(v))})' "$1"; }
ACCEPT=":(glob)$(cfg tests.acceptance_glob)"
ACCEPT_RE=$(cfg tests.acceptance_regex)
CONTRACT_ERRORS=$(cfg tests.contract_errors)
mapfile -t SETUP_CFG < <(cfg tests.locked_also | sed 's#^\([^:]\)#:(glob)\1#')
# Paths that belong to the factory or the engine. None of them may ever be committed to the project (PLAN C1).
FACTORY_PATHS=(.digital-factory .digital-factory-outputs .task-state .factory .intent-loop .code-compass .copilot-cache)
LOCAL_DIR=$(cfg git.local_dir); LOCAL_DIR=${LOCAL_DIR:-.itera}
has_origin() { git remote get-url origin >/dev/null 2>&1; }

plan_hash() {
  local f=${1:-}
  [ -n "$f" ] && [ -f "$f" ] || { echo none; return 0; }
  git hash-object --no-filters -- "$f"
}

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

# Tree hash of the whole working tree (tracked + untracked, honouring .gitignore) in a throwaway index outside the repo.
tree_fingerprint() {
  local idx="$RUN/tmp/guard-idx.$$" rc=0 t="" p l
  local -a ign=("$@")
  while IFS= read -r l || [ -n "$l" ]; do
    l=${l%%#*}; l=$(printf %s "$l" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "$l" ] && ign+=("$l")
  done < <(fshow scripts/guard-ignore 2>/dev/null)
  rm -f "$idx"
  GIT_INDEX_FILE=$idx git read-tree HEAD && GIT_INDEX_FILE=$idx git add -A -- . || rc=1
  if [ $rc -eq 0 ]; then
    for p in ${ign[@]+"${ign[@]}"}; do
      GIT_INDEX_FILE=$idx git rm -r -q --cached --ignore-unmatch -- "$p" >/dev/null || { rc=1; break; }
    done
  fi
  [ $rc -eq 0 ] && { t=$(GIT_INDEX_FILE=$idx git write-tree) || rc=1; }
  rm -f "$idx"
  [ $rc -eq 0 ] && printf '%s\n' "$t"
  return $rc
}

# Stop processes an agent recorded in <run>/pids-* and left running (dev servers after a validator crash).
# Windows: taskkill on the Windows PID the agent recorded; only PIDs whose image is node/dotnet are touched.
kill_recorded() {
  local f pid n=0 img
  for f in $1; do
    [ -f "$f" ] || continue
    while IFS= read -r pid || [ -n "$pid" ]; do
      pid=$(printf %s "$pid" | tr -cd 0-9); [ -n "$pid" ] && [ "$pid" -gt 4 ] || continue
      img=$(tasklist.exe //FI "PID eq $pid" //NH //FO CSV 2>/dev/null | head -1 | cut -d, -f1 | tr -d '"')
      case "$img" in node.exe|dotnet.exe|LCA.*.exe) taskkill.exe //PID "$pid" //T //F >/dev/null 2>&1 && n=$((n + 1)) ;; esac
    done < "$f"
    rm -f "$f"
  done
  [ "$n" -gt 0 ] && echo "CLEANUP: stopped $n leftover process(es)" >&2
  return 0
}

accept_hash() {
  local f list=""
  while IFS= read -r f; do
    if [ -f "$f" ]; then list+="$f $(git hash-object --no-filters -- "$f")"$'\n'; else list+="$f deleted"$'\n'; fi
  done < <(git ls-files -co --exclude-standard -- "$ACCEPT" | sort -u)
  [ -n "$list" ] || return 1
  printf %s "$list" | git hash-object --stdin
}
# Source files named as the location of an error in a build log. Handles MSBuild's absolute Windows paths
# (C:\...\File.cs(12,5): error CS0246) as well as tsc's (src/x.ts:3:1 - error TS2307).
build_error_files() {
  local root; root=$(pwd -W 2>/dev/null || pwd)
  tr '\\' '/' < "$1" \
    | awk 'tolower($0) ~ /error/ && match($0, /[A-Za-z0-9_.@\/:+-]+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|cs|csproj|py|go|rs|java|kt)/) { print substr($0, RSTART, RLENGTH) }' \
    | sed -e "s#^$root/##I" -e "s#^$PWD/##" -e 's#^\./##' | sort -u
}
setup_hash() {
  local f list=""
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    list+="$f $(node -e 'let o={};try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).scripts||{};for(const k of Object.keys(s).sort())if(/^((pre|post)?(test|build|lint)|typecheck)($|:)/.test(k))o[k]=s[k]}catch(e){o="unparsable"}process.stdout.write(JSON.stringify(o))' "$f")"$'\n'
  done < <(git ls-files -co --exclude-standard -- ':(glob)**/package.json' | sort -u)
  if [ ${#SETUP_CFG[@]} -gt 0 ]; then
    while IFS= read -r f; do
      [ -f "$f" ] && list+="$f $(git hash-object --no-filters -- "$f")"$'\n'
    done < <(git ls-files -co --exclude-standard -- "${SETUP_CFG[@]}" | sort -u)
  fi
  printf %s "$list" | git hash-object --stdin
}
# Factory or engine files in the project worktree: changed vs the story base, staged, or untracked (also ignored ones).
# Prints them space-separated; empty = clean. (Replaces protected_changes: the loop's own files are not in the project.)
# The one allowed local folder is $LOCAL_DIR (.itera/), which the project ignores (setup PR). It may exist untracked and
# ignored, but never committed or staged, and it must really be ignored. Any other factory path anywhere is a violation.
isolation_violations() {
  local -a ps=() ls=(":(glob)$LOCAL_DIR/**")
  local p
  for p in "${FACTORY_PATHS[@]}"; do ps+=(":(glob)$p" ":(glob)$p/**" ":(glob)**/$p/**"); done
  {
    git diff --name-only "origin/$base" -- "${ps[@]}" "${ls[@]}"      # committed on the branch
    git diff --cached --name-only -- "${ps[@]}" "${ls[@]}"            # staged
    git ls-files -o -- "${ps[@]}"                                     # untracked, ignored ones included
    [ -e "$LOCAL_DIR" ] && ! git check-ignore -q "$LOCAL_DIR/x" && echo "$LOCAL_DIR/(not-ignored)"
  } 2>/dev/null | sort -u | paste -sd ' ' -
}
sensitive_staged() {
  git diff --cached --name-only \
    | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|\.pfx$|(^|/)id_rsa|(^|/)node_modules/|\.log$|(^|/)dist/|(^|/)(bin|obj)/|\.db$|appsettings\.Local\.json$|\.user$' \
    | grep -vE '(^|/)\.env\.example$'
}
role_exclude() { [ "$1" = test_author ] && printf '%s' "$ACCEPT"; }

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
  if [ "$head_now" != "$head_before" ] || [ "$(git branch --show-current)" != "$branch" ]; then
    st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The $role reported $tok but moved HEAD or switched branches while it ran (now $(git branch --show-current)@$head_now, expected $branch@$head_before), so the $tok was rejected."
    echo "GUARD=HEAD_MOVED"; exit 1
  fi
  ex=$(role_exclude "$role")
  after=$(tree_fingerprint ${ex:+"$ex"}) && [ -n "$after" ] || guard_err "could not fingerprint the tree"
  if [ "$before" != "$after" ]; then
    changed=$(git diff-tree -r --name-status "$before" "$after" | tr '\t' ' ' | paste -sd ';' -)
    if [ "$role" = test_author ]; then
      st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The test author may only write acceptance test files ($(cfg tests.acceptance_glob)) but changed other files, so its tests were not accepted. Changed: $changed. Put helpers inside the acceptance test files and leave everything else untouched."
    else
      st status=escalated "phase=$ph" "verdicts.$role=MODIFIED_FILES" "feedback.$role=The $role reported $tok but modified files while it ran (it must not change code), so the $tok was rejected. Changed: $changed. Review these changes; keep them only if they belong to the story."
    fi
    echo "GUARD=MODIFIED $changed"
    exit 1
  fi
}

# Build then test, always both, from the repo root. Writes <log>; sets brc/rc/why. Shared by preflight and run-tests.
run_build_and_tests() {
  local log=$1 blog=$2 bcmd tcmd
  bcmd=$(cfg commands.build); tcmd=$(cfg commands.test)
  brc=0
  if [ -n "$bcmd" ]; then { echo "\$ $bcmd"; bash -c "$bcmd" </dev/null; } >"$blog" 2>&1; brc=$?; fi
  {
    [ -n "$bcmd" ] && { echo "===== BUILD: $([ $brc -eq 0 ] && echo passed || echo "FAILED (exit $brc)")"; cat "$blog"; echo; echo "===== TESTS"; }
    echo "\$ $tcmd"; bash -c "$tcmd" </dev/null
  } >"$log" 2>&1; rc=$?
  why=""
  if [ $rc -ne 0 ]; then why="exit code $rc"
  elif grep -Eq '^(ℹ|#) tests 0$|Total tests: 0|Executed 0 of' "$log"; then why="the test runner executed 0 tests"
  fi
}

case "$cmd" in
git-meta) git_meta_hash; exit ;;
plan-hash) plan_hash "${1:-}"; exit ;;
snapshot|branch|park|preflight) ;;
*) [ -z "$META" ] && { echo "GIT_META=MISSING: no STORY_META baseline for $cmd" >&2; exit 1; } ;;
esac
if [ -n "$META" ]; then
  now_meta=$(git_meta_hash)
  if [ "$now_meta" != "$META" ]; then
    st status=needs_human "feedback.engine=GIT_META_CHANGED: git hooks or git config of the project changed during the run (before $cmd). They can make git run arbitrary code, so the run was stopped. Inspect .git/hooks, core.hooksPath, .git/info/ and 'git config --list --show-origin', then retry."
    echo "GIT_META=CHANGED (before $cmd)" >&2
    exit 1
  fi
fi

case "$cmd" in
preflight)
  # On the untouched story base, before any agent: is the base itself green? A red base is never the story's fault.
  # Prints exactly GREEN (passed, or skipped on a retry with "skip") so the next task can gate on it with one ==.
  if [ "${1:-run}" = skip ]; then
    [ -n "$(ts get "$task_id" base_sha 2>/dev/null)" ] || fail preflight PREFLIGHT=FAILED "skip requested but no preflight was recorded"
    echo "preflight skipped (retry; recorded on attempt 1)" >&2; printf GREEN; exit 0
  fi
  [ -z "$(git status --porcelain)" ] || fail preflight PREFLIGHT=FAILED "worktree not clean before the run"
  icmd=$(cfg commands.install)
  if [ -n "$icmd" ]; then bash -c "$icmd" </dev/null >"$RUN/logs/preflight-install.log" 2>&1 || fail preflight PREFLIGHT=FAILED "install failed (see logs/preflight-install.log)"; fi
  run_build_and_tests "$RUN/logs/preflight.log" "$RUN/tmp/preflight-build.log"
  if [ $brc -ne 0 ]; then
    st status=needs_human phase=preflight "feedback.engine=BASE_RED: the build fails on the story base $base before any change (see logs/preflight.log). Not the story's fault; fix the base or choose another."
    echo "PREFLIGHT=BASE_BUILD_RED"; exit 1
  fi
  if [ -n "$why" ]; then
    st status=needs_human phase=preflight "feedback.engine=BASE_RED: tests fail on the story base $base before any change ($why, see logs/preflight.log)."
    echo "PREFLIGHT=BASE_TESTS_RED"; exit 1
  fi
  [ -z "$(git status --porcelain)" ] || fail preflight PREFLIGHT=FAILED "build or tests changed tracked files: $(git status --porcelain | head -5 | paste -sd ' ' -)"
  st phase=preflight status=in_progress "base_sha=$(git rev-parse HEAD)"
  printf GREEN
  ;;
branch)
  st phase=branched status=in_progress
  kill_recorded "$RUN/pids-*"
  gd=$(git rev-parse --git-dir) || fail branched BRANCH=FAILED no-git-dir
  for op in merge:MERGE_HEAD rebase:rebase-merge rebase:rebase-apply cherry-pick:CHERRY_PICK_HEAD revert:REVERT_HEAD; do
    if [ -e "$gd/${op#*:}" ]; then
      git "${op%%:*}" --abort >/dev/null 2>&1 || fail branched BRANCH=FAILED "cannot-abort-${op%%:*}"
      echo "RECOVERED: aborted interrupted ${op%%:*}" >&2
    fi
  done
  ts set "$task_id" 'verdicts={}' >/dev/null || fail branched BRANCH=FAILED state-reset
  [ "$(git branch --show-current)" = "$branch" ] || fail branched BRANCH=FAILED "worktree not on $branch (on $(git branch --show-current))"
  st phase=branched status=in_progress "branch=$branch"
  echo "BRANCH=$branch BASE=$base"
  ;;
snapshot)
  [ "$(git branch --show-current)" = "$branch" ] || fail validating GUARD=FAILED "not-on:$branch"
  h=$(git rev-parse HEAD) || fail validating GUARD=FAILED rev-parse
  ex=$(role_exclude "${1:-}")
  t=$(tree_fingerprint ${ex:+"$ex"}) && [ -n "$t" ] || fail validating GUARD=FAILED snapshot
  bs=$(ts get "$task_id" base_sha 2>/dev/null); [ -n "$bs" ] || bs=$(git rev-parse "origin/$base" 2>/dev/null || echo -)
  mh=${META:-$(git_meta_hash)} && [ -n "$mh" ] || fail validating GUARD=FAILED git-meta
  echo "$t $h $TRUST $bs $mh"
  ;;
verify)
  do_verify "${2:-}" "${3:-}" "${1:-validator}"
  echo "GUARD=UNCHANGED"
  ;;
lock-tests)
  attempt=${1:-}
  v=$(ts get "$task_id" verdicts.test_author 2>/dev/null); a=$(ts get "$task_id" verdicts.test_author_attempt 2>/dev/null)
  [ "$v" = DONE ] && [ "$a" = "$attempt" ] || { echo "LOCK=NO test author verdict '$v' (attempt '$a', expected DONE/$attempt)" >&2; exit 1; }
  do_verify "${2:-}" "${3:-}" test_author >&2
  mine=$( { git diff --name-only "origin/$base" -- "$ACCEPT"; git ls-files -o --exclude-standard -- "$ACCEPT"; } | sort -u)
  if [ -z "$mine" ]; then
    st status=escalated phase=tests_written verdicts.test_author=NO_TESTS "feedback.test_author=No acceptance test file ($(cfg tests.acceptance_glob)) was added or changed for this story (compared with $base). Write acceptance tests for the acceptance criteria."
    echo "LOCK=NO_TESTS" >&2; exit 1
  fi
  h=$(accept_hash) || { echo "LOCK=NO_HASH" >&2; exit 1; }
  su=$(setup_hash) || { echo "LOCK=NO_SETUP_HASH" >&2; exit 1; }
  st phase=tests_written status=in_progress
  printf '%s %s' "$h" "$su"
  ;;
run-tests)
  attempt=${1:-}
  [ "$(git branch --show-current)" = "$branch" ] || { printf NOT_RUN; echo "run-tests: not on $branch" >&2; exit 1; }
  v=$(ts get "$task_id" verdicts.implementer 2>/dev/null); a=$(ts get "$task_id" verdicts.implementer_attempt 2>/dev/null)
  [ "$v" = DONE ] && [ "$a" = "$attempt" ] || { printf NOT_RUN; echo "run-tests: implementer verdict '$v' (attempt '$a')" >&2; exit 0; }
  iv=$(isolation_violations)
  if [ -n "$iv" ]; then
    st phase=tested status=escalated verdicts.tester=ISOLATION "verdicts.tester_attempt=$attempt" "feedback.tester=Factory or engine files appeared in the project worktree: $iv. They must never be created there. Implementer: delete them."
    printf ISOLATION; echo "run-tests: factory files in the project: $iv" >&2; exit 0
  fi
  st phase=testing status=in_progress
  log=$RUN/logs/test-$attempt.log blog=$RUN/tmp/build-$attempt.log
  run_build_and_tests "$log" "$blog"
  verdict=GREEN
  if [ $brc -ne 0 ]; then
    files=$(build_error_files "$blog"); acc=$(printf '%s\n' "$files" | grep -E "$ACCEPT_RE" || true)
    other=$(printf '%s\n' "$files" | grep -vE "$ACCEPT_RE" | grep . || true)
    if [ -n "$acc" ] && [ -z "$other" ] && ! grep -Eq "$CONTRACT_ERRORS" "$blog"; then verdict=ACCEPTANCE_TESTS_BUILD_FAIL
    else verdict=BUILD_FAIL; fi
  elif [ -n "$why" ]; then verdict=TEST_FAIL
  fi
  rm -f "$blog"
  case $verdict in
    GREEN)
      st phase=tested status=in_progress verdicts.tester=GREEN "verdicts.tester_attempt=$attempt" feedback.tester=
      printf GREEN; exit 0 ;;
    BUILD_FAIL) fb="the build failed (exit $brc)${why:+; the tests failed too ($why), possibly because of the build errors}" ;;
    ACCEPTANCE_TESTS_BUILD_FAIL) fb="the build failed (exit $brc) only in acceptance test files ($(printf '%s' "$acc" | paste -sd ' ' -)): the test author must fix them; this attempt is not counted${why:+. The tests failed too ($why)}" ;;
    TEST_FAIL) fb="the tests failed ($why)" ;;
  esac
  st phase=tested status=escalated "verdicts.tester=$verdict" "verdicts.tester_attempt=$attempt" \
    "feedback.tester=$fb. Last lines of the log: $(tail -n 30 "$log")"
  printf TEST_GATE_FAIL
  ;;
gate-test)
  res=${1:-}; lock=${2:-}; lock_setup=${3:-}
  [ -n "$lock" ] && [ -n "$lock_setup" ] || { echo "CHECK=NO_LOCK" >&2; exit 1; }
  now=$(accept_hash)
  if [ "$now" != "$lock" ]; then
    files=$( { git diff --name-only "origin/$base" -- "$ACCEPT"; git ls-files -o --exclude-standard -- "$ACCEPT"; } | sort -u | paste -sd ' ' -)
    st status=escalated phase=tested verdicts.tester=MODIFIED_TESTS "feedback.tester=The implementer changed, added, renamed or deleted acceptance test files after they were locked ($files). Make the tests pass by implementing the behaviour, or record TEST_DISPUTE. Test author: restore your tests."
    echo "CHECK=MODIFIED_TESTS" >&2; exit 1
  fi
  if [ "$(setup_hash)" != "$lock_setup" ]; then
    st status=escalated phase=tested verdicts.tester=MODIFIED_TEST_SETUP "feedback.tester=The implementer changed the locked test setup after the acceptance tests were locked (package.json test/build/lint scripts or: $(cfg tests.locked_also | paste -sd ' ' -)). Revert those changes; the tests must run unchanged."
    echo "CHECK=MODIFIED_TEST_SETUP" >&2; exit 1
  fi
  if [ "$res" != GREEN ] && [ "$(ts get "$task_id" verdicts.tester 2>/dev/null)" = GREEN ]; then
    st verdicts.tester=TEST_FAIL status=escalated
  fi
  echo "CHECK=OK" >&2
  [ "$(git branch --show-current)" = "$branch" ] && [ "$res" = GREEN ] && printf GREEN
  exit 0
  ;;
gate)
  role=${1:-}; attempt=${2:-}
  case "$role" in reviewer) pass=CLEAR ;; validator) pass=PASS ;; *) echo "gate: unknown role $role" >&2; exit 2 ;; esac
  v=$(ts get "$task_id" "verdicts.$role" 2>/dev/null); a=$(ts get "$task_id" "verdicts.${role}_attempt" 2>/dev/null)
  [ -n "$v" ] && [ "$a" = "$attempt" ] || { echo "GATE: no $role verdict for attempt $attempt ('$v', attempt '$a')" >&2; exit 1; }
  [ "$v" = "$pass" ] && { do_verify "${3:-}" "${4:-}" "$role" >&2; echo "GUARD=UNCHANGED" >&2; }
  [ "$(git branch --show-current)" = "$branch" ] || { echo "GATE: not on $branch" >&2; exit 1; }
  printf %s "$v"
  ;;
publish)
  mode=${1:-dry}; STORY_PLAN_FILE=${2:-}; STORY_PLAN_HASH=${3:-}
  st phase=publishing status=in_progress
  [ "$(git branch --show-current)" = "$branch" ] || fail publishing PUBLISH=FAILED "not-on:$branch"
  case " $(cfg publish.never_push | paste -sd ' ' -) " in *" $branch "*) fail publishing PUBLISH=FAILED "refusing to publish protected branch $branch" ;; esac
  has_origin && git fetch -q origin "$base" 2>/dev/null
  bs=$(ts get "$task_id" base_sha 2>/dev/null)
  if [ -n "$bs" ] && [ "$(git rev-parse "origin/$base" 2>/dev/null)" != "$bs" ]; then
    st phase=publishing status=needs_human "feedback.engine=BASE_MOVED: $base moved during the run (was $bs, now $(git rev-parse --short "origin/$base")). Rebase decision is a human's."
    echo "PUBLISH=BASE_MOVED"; exit 1
  fi
  if [ -n "$STORY_PLAN_FILE" ] && [ "$(plan_hash "$STORY_PLAN_FILE")" != "$STORY_PLAN_HASH" ]; then
    st phase=publishing status=needs_human "feedback.engine=PLAN_CHANGED: the story file changed during the run; nothing was published."
    echo "PUBLISH=PLAN_CHANGED"; exit 1
  fi
  iv=$(isolation_violations)
  [ -z "$iv" ] || fail publishing PUBLISH=ISOLATION "factory files in the project worktree: $iv"
  # Stage exactly the story's paths (never `add -A` blindly): everything git reports as changed or untracked.
  mapfile -t paths < <(git status --porcelain=v1 -z --untracked-files=all | tr '\0' '\n' | grep -E '^.. ' | cut -c4-)
  [ ${#paths[@]} -gt 0 ] && git add -- "${paths[@]}"
  bad=$(sensitive_staged | tr '\n' ' ')
  if [ -n "$bad" ]; then git reset -q; fail publishing PUBLISH=ABORTED_SENSITIVE_FILES "${bad}- implementer: delete these files or ignore them in the project's own way"; fi
  title=$(ts get "$task_id" pr.title 2>/dev/null); summary=$(ts get "$task_id" pr.summary 2>/dev/null)
  [ -n "$title" ] && [ -n "$summary" ] || fail publishing PUBLISH=FAILED "no PR title/summary from the pr-writer"
  subj=$(cfg git.commit.subject); subj=${subj//\{local_id\}/$(ts get "$task_id" local_id)}; subj=${subj//\{summary\}/$summary}
  re=$(cfg git.commit.subject_must_match); [ -z "$re" ] || printf %s "$subj" | grep -Eq "$re" || fail publishing PUBLISH=FAILED "commit subject does not match the project rule: $subj"
  if ! git diff --cached --quiet; then
    git -c user.name="$(cfg git.commit.author_name)" -c user.email="$(cfg git.commit.author_email)" commit -q -m "$subj" || fail publishing PUBLISH=FAILED commit
  fi
  [ "$(git rev-list --count "origin/$base..HEAD")" -gt 0 ] || fail publishing PUBLISH=FAILED nothing-to-publish
  iv=$(isolation_violations); [ -z "$iv" ] || fail publishing PUBLISH=ISOLATION "after commit: $iv"
  body="$RUN/pr-body.md"; ts get "$task_id" pr.body > "$body" 2>/dev/null
  dis=$( { cat "$body"; git log --format='%an <%ae>%n%B' "origin/$base..HEAD"; } | grep -inE 'claude|anthropic|digital[ -]?factory|code[ -]?compass|co-authored-by|generated (with|by)|\bAI\b|\bLLM\b|copilot' | head -3)
  [ -z "$dis" ] || fail publishing PUBLISH=DISCLOSURE "hidden mode, but found: $(printf %s "$dis" | paste -sd ' ' -)"
  words=$(wc -w < "$body"); max=$(cfg publish.pr_max_words)
  [ "$words" -le $((max + 120)) ] || fail publishing PUBLISH=FAILED "PR body has $words words (limit $max + checklist)"
  if [ "$mode" != draft-pr ]; then
    st phase=published status=pr_ready "commit=$(git rev-parse HEAD)" publish_mode=dry
    echo "PUBLISH=DRY commit=$(git rev-parse --short HEAD) body=$body"; exit 0
  fi
  git push -q -u origin "HEAD:refs/heads/$branch" || fail publishing PUBLISH=FAILED push
  acct=$(cfg publish.gh_account); prev=$(gh api user -q .login 2>/dev/null)
  restore() { [ -n "$prev" ] && [ "$prev" != "$acct" ] && gh auth switch -h github.com -u "$prev" >/dev/null 2>&1; }
  trap restore EXIT
  [ "$prev" = "$acct" ] || gh auth switch -h github.com -u "$acct" >/dev/null 2>&1 || fail publishing PUBLISH=FAILED "gh account $acct"
  args=(--repo "$(cfg repo.github)" --draft --base "$base" --head "$branch" --title "$title" --body-file "$body")
  while IFS= read -r a; do [ -n "$a" ] && args+=(--assignee "$a"); done < <(cfg publish.assignees)
  url=$(gh pr create "${args[@]}" 2>&1 | tail -1) || fail publishing PUBLISH=FAILED "gh pr create: $url"
  st phase=published status=pr_open "commit=$(git rev-parse HEAD)" "pr=$url"
  echo "PUBLISH=PR $url"
  ;;
park)
  [ "$(git branch --show-current)" = "$branch" ] || { echo "PARK=SKIPPED not on $branch"; exit 0; }
  mapfile -t paths < <(git status --porcelain=v1 -z --untracked-files=all | tr '\0' '\n' | grep -E '^.. ' | cut -c4-)
  [ ${#paths[@]} -gt 0 ] && git add -- "${paths[@]}"
  if [ -n "$(sensitive_staged)" ]; then git reset -q; echo "PARK=SKIPPED sensitive files present; work left uncommitted in the worktree"; exit 0; fi
  if ! git diff --cached --quiet; then
    subj=$(cfg git.commit.subject); subj=${subj//\{local_id\}/$(ts get "$task_id" local_id)}; subj=${subj//\{summary\}/WIP, not published}
    git -c user.name="$(cfg git.commit.author_name)" -c user.email="$(cfg git.commit.author_email)" commit -q -m "$subj" || { echo "PARK=FAILED commit"; exit 1; }
  fi
  echo "PARK=OK BRANCH=$branch (local only, not pushed)"
  ;;
cleanup)
  kill_recorded "$RUN/pids-$task_id"
  echo "CLEANUP=OK"
  ;;
*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
