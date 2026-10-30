#!/usr/bin/env bash
# One deterministic tick of the intent orchestrator (see .claude/skills/intent-orchestrator/SKILL.md).
# Run from the target repo (REPO = cwd):  orchestrate-tick.sh [intents-folder]
# Picks the next eligible intent, runs the intent-to-merge workflow on it, judges the result from the
# state file, parks an intent whose attempts are exhausted, and ends with exactly one line:
#   LOOP: CONTINUE | LOOP: STOP (<reason>)
# Exit code: 0 when the tick ran normally (whatever the outcome), 1 on a preflight/setup error.
# Env overrides: MAX_ATTEMPTS (3), TICK_TIMEOUT seconds (6000, backstop for a hung run),
#   WORKFLOW, TOOLING (task-state.js), DF_BIN (digital-factory binary), POLL (10 s),
#   BROWSER_CHECK (1; 0 skips the Chromium preflight), PW_DIR (~/.cache/intent-orchestrator/pw).
set -uo pipefail
for v in $(env | grep -oE '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)='); do unset "${v%=}"; done

LOOP_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
WORKFLOW=${WORKFLOW:-$LOOP_HOME/intent-to-merge.yaml}
TOOLING=${TOOLING:-$LOOP_HOME/task-state.js}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
TICK_TIMEOUT=${TICK_TIMEOUT:-6000}
POLL=${POLL:-10}
# The engine: DF_BIN, else on the PATH, else the usual install in the home folder, else a .digital-factory
# folder in one of the project's parent folders (an engine kept next to the projects).
if [ -z "${DF_BIN:-}" ]; then
  DF_SEARCHED="PATH, $HOME/.digital-factory"
  DF_BIN=$(command -v digital-factory 2>/dev/null) || DF_BIN=$HOME/.digital-factory/digital-factory
  d=$(dirname "$LOOP_HOME")
  while [ ! -x "$DF_BIN" ] && [ "$d" != / ]; do
    DF_BIN=$d/.digital-factory/digital-factory; DF_SEARCHED="$DF_SEARCHED, $d/.digital-factory"; d=$(dirname "$d")
  done
  [ -x "$DF_BIN" ] || DF_BIN="digital-factory (searched: $DF_SEARCHED)"
fi
REPO=$(pwd -P)
ARG=${1:-}
TS=.intent-loop/task-state.js

say() { printf '%s\n' "$*"; }
stop() { say "LOOP: STOP ($1)"; exit "${2:-0}"; }
ts() { "$TS" "$@"; }
jget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split(".")){v=v==null?v:v[k]}process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }

[ -f "$WORKFLOW" ] || stop "workflow not found: $WORKFLOW" 1
[ -x "$DF_BIN" ] || stop "digital-factory binary not found: $DF_BIN; set DF_BIN to its path" 1

# --- 1. Preflight -------------------------------------------------------------------------------
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -q -b main && say "preflight: initialised git repo (branch main)"
fi
if ! git rev-parse -q --verify HEAD >/dev/null; then
  # Empty commit only: never stage whatever happens to be in the folder (could be secrets).
  git commit -q --allow-empty -m "Initial commit" && say "preflight: created empty initial commit"
fi
mkdir -p .task-state/logs
grep -qxF '.task-state/' "$(git rev-parse --git-path info/exclude)" 2>/dev/null \
  || { mkdir -p "$(dirname "$(git rev-parse --git-path info/exclude)")"; echo '.task-state/' >> "$(git rev-parse --git-path info/exclude)"; }

# One tick at a time (a second /loop or a manual run must not start a parallel workflow).
LOCK=.task-state/orchestrator.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then stop "another tick is running (pid $old)"; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || stop "cannot take $LOCK" 1
  say "preflight: removed stale lock (pid ${old:-?})"
fi
echo $$ > "$LOCK/pid"
DF_PID=""
on_exit() {
  [ -n "$DF_PID" ] && kill -0 "$DF_PID" 2>/dev/null && kill -TERM -- "-$DF_PID" 2>/dev/null
  rm -rf "$LOCK"
}
trap on_exit EXIT
trap 'say "interrupted"; exit 130' INT TERM

# task-state.js: install if missing; agents could tamper with it between runs, so check it.
if [ ! -f "$TS" ]; then
  mkdir -p .intent-loop && cp "$TOOLING" "$TS" && chmod +x "$TS" && say "preflight: installed $TS (not committed)"
elif git ls-files --error-unmatch "$TS" >/dev/null 2>&1; then
  git diff --quiet HEAD -- "$TS" || stop "$TS has uncommitted changes; review and commit or revert them"
elif [ "$(cd "$(dirname "$TOOLING")" && pwd -P)/$(basename "$TOOLING")" != "$REPO/$TS" ] && ! cmp -s "$TOOLING" "$TS"; then
  cp "$TOOLING" "$TS" && say "preflight: $TS differed from $TOOLING; restored it"
fi

if [ -f .task-state/state.json ]; then
  out=$(ts sync ${ARG:+"$ARG"} 2>&1) || { say "$out"; stop "state sync failed" 1; }
  [ "$(printf %s "$out" | jget synced)" = 0 ] || say "preflight: new intents added: $out"
else
  dir=$ARG
  if [ -z "$dir" ]; then
    for d in planning/intents intents; do [ -d "$d" ] && { dir=$d; break; }; done
  fi
  [ -n "$dir" ] || stop "no state file and no intents folder; pass one: orchestrate-tick.sh <folder>" 1
  ts init "$dir" || stop "state init failed" 1
fi

# --- 2. Select ----------------------------------------------------------------------------------
nx=$(ts next "$MAX_ATTEMPTS") || stop "task-state.js next failed" 1
case "$(printf %s "$nx" | jget action)" in
  done) say "All intents completed."; stop "all intents completed" ;;
  blocked)
    say "Nothing can run:"
    printf %s "$nx" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const w of JSON.parse(d).waiting||[])console.log(`  ${w.id}\t${w.reason}`)})'
    stop "blocked: needs human" ;;
  run) ;;
  *) say "$nx"; stop "unexpected output from next" 1 ;;
esac
id=$(printf %s "$nx" | jget id); slug=$(printf %s "$nx" | jget branch_slug)
base=$(printf %s "$nx" | jget base_branch); n=$(printf %s "$nx" | jget attempt)
ifile=$(printf %s "$nx" | jget intent_file)
case "$ifile" in /*) ;; *) ifile=$REPO/$ifile ;; esac
[ -f "$ifile" ] || stop "intent file not found: $ifile" 1

# --- 3. Safety check ----------------------------------------------------------------------------
cur=$(git rev-parse --abbrev-ref HEAD)
dirty=$(git status --porcelain -- . ':(exclude).task-state' ":(exclude)$TS" ':(exclude).digital-factory' ':(exclude).digital-factory-outputs' ':(exclude).copilot-cache')
if [ -n "$dirty" ] && [ "$cur" != "feature/$slug" ]; then
  stop "dirty working tree on another branch: $cur"
fi

# --- 3b. Browser check: the validator drives UI metrics with headless Playwright Chromium --------
# Kept in a shared tool dir outside the repo (so it never touches the project's lock files). Installs
# Playwright and Chromium on first use and, with passwordless sudo, the OS libraries Chromium needs.
# Stops before an attempt is used up when the browser still cannot start. BROWSER_CHECK=0 skips it.
browser_launch() {
  (cd "$PW_DIR" && node -e 'require("playwright").chromium.launch().then(b=>b.close()).then(()=>process.exit(0),e=>{const l=String(e.message).split("\n").map(s=>s.trim()).filter(Boolean);const k=l.filter(s=>/shared librar|missing|doesn.t exist|not found|error/i.test(s)&&!/^<launching>/.test(s));console.error((k.length?k:l).slice(0,2).join(" | ").slice(0,400));process.exit(1)})') 2>&1
}
if [ "${BROWSER_CHECK:-1}" != 0 ]; then
  PW_DIR=${PW_DIR:-$HOME/.cache/intent-orchestrator/pw}
  if [ ! -d "$PW_DIR/node_modules/playwright" ]; then
    say "preflight: installing Playwright in $PW_DIR"
    (mkdir -p "$PW_DIR" && cd "$PW_DIR" && { [ -f package.json ] || npm init -y >/dev/null; } \
      && npm install --silent --no-audit --no-fund playwright >/dev/null) 2>&1 | tail -5
    [ -d "$PW_DIR/node_modules/playwright" ] || stop "browser check: cannot install Playwright in $PW_DIR (BROWSER_CHECK=0 skips this check)" 1
  fi
  if ! err=$(browser_launch); then
    say "preflight: Chromium does not start ($err); installing it"
    (cd "$PW_DIR" && npx --no-install playwright install chromium) 2>&1 | tail -3
    if ! browser_launch >/dev/null && sudo -n true 2>/dev/null; then
      say "preflight: installing Chromium system libraries (sudo)"
      (cd "$PW_DIR" && sudo -n env "PATH=$PATH" npx --no-install playwright install-deps chromium) 2>&1 | tail -3
    fi
    err=$(browser_launch) || stop "browser check: Chromium cannot start: $err. Fix once per machine: (cd $PW_DIR && sudo npx playwright install-deps chromium), or set BROWSER_CHECK=0 for projects without a UI" 1
    say "preflight: Chromium ready ($PW_DIR)"
  fi
fi

# --- 4. Record the attempt ----------------------------------------------------------------------
ts set "$id" "attempts=$n" status=in_progress >/dev/null || stop "cannot record attempt" 1
say "[$id #$n/$MAX_ATTEMPTS] starting (branch feature/$slug)"

# --- 5. Run the workflow (own process group, so a timeout can stop the agents too) ---------------
# Trusted intent-git.sh (from the base branch, kept in memory) and the git hooks/config baseline: the
# workflow re-checks it before each of its git steps, and this script checks it again after the run.
trust=$(git rev-parse "$base") && IG=$(git show "$trust:.intent-loop/intent-git.sh") && [ -n "$IG" ] \
  || stop ".intent-loop/intent-git.sh is not committed on $base" 1
ig() { INTENT_TRUST=$trust bash -c "$IG" intent-git.sh "$@"; }
meta0=$(ig git-meta "$id" "$slug" "$base") && [ -n "$meta0" ] || stop "cannot hash git hooks/config" 1
LOG=.task-state/logs/$id-$n.log
set -m
env -u GIT_CONFIG_COUNT "$DF_BIN" workflow run --allow-cross-directory -w "$REPO" \
  --set "intent_file=$ifile" --set "repo_path=$REPO" --set "branch_slug=$slug" --set "git_meta=$meta0" \
  --set "base_branch=$base" --set "task_id=$id" --set "attempt=$n" "$WORKFLOW" </dev/null >"$LOG" 2>&1 &
DF_PID=$!
set +m
start=$(date +%s); shown=0; last_v=""; timed_out=no
while kill -0 "$DF_PID" 2>/dev/null; do
  sleep "$POLL"
  lines=$(sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$LOG" 2>/dev/null | grep -E '^ *(✓|✗|⚠) ' | grep -v Phase)
  cnt=$(printf '%s' "$lines" | grep -c . || true)
  if [ "$cnt" -gt "$shown" ]; then
    printf '%s\n' "$lines" | tail -n "+$((shown + 1))" | sed "s/^ */[$id #$n] /"
    shown=$cnt
  fi
  v=$(ts get "$id" verdicts 2>/dev/null | tr -d ' \n')
  [ -n "$v" ] && [ "$v" != "$last_v" ] && [ "$v" != "{}" ] && { say "[$id #$n] verdicts: $v"; last_v=$v; }
  if [ $(( $(date +%s) - start )) -ge "$TICK_TIMEOUT" ]; then
    say "[$id #$n] TIMEOUT after ${TICK_TIMEOUT}s: stopping the run"
    kill -TERM -- "-$DF_PID" 2>/dev/null; sleep 5; kill -KILL -- "-$DF_PID" 2>/dev/null
    timed_out=yes; break
  fi
done
wait "$DF_PID" 2>/dev/null; rc=$?
DF_PID=""
say "[$id #$n] workflow finished (engine exit $rc, log $LOG)"

# Before any other git command: did the run plant hooks or change git config?
meta_bad=no
if [ "$(ig git-meta "$id" "$slug" "$base")" != "$meta0" ]; then
  meta_bad=yes
  case "$(ts get "$id" feedback.engine 2>/dev/null)" in
    GIT_META_CHANGED*) ;;
    *) ts set "$id" status=needs_human "feedback.engine=GIT_META_CHANGED: git hooks or git config changed during the run. They can make git run arbitrary code, so nothing more was executed (not parked). Inspect .git/hooks, core.hooksPath, .git/info/ and 'git config --list --show-origin', revert anything unexpected, then retry with status=pending attempts=0." >/dev/null ;;
  esac
fi

# --- 6. Judge by the state file -----------------------------------------------------------------
status=$(ts get "$id" status 2>/dev/null)
outcome=""
case "$status" in
  completed) outcome="COMPLETED commit $(ts get "$id" commit 2>/dev/null)" ;;
  needs_human)
    eng=$(ts get "$id" feedback.engine 2>/dev/null); issue=""
    for r in test_author implementer reviewer validator; do
      [ "$(ts get "$id" "verdicts.$r" 2>/dev/null)" = INTENT_ISSUE ] && { issue=$r; break; }
    done
    case "$eng" in
      GIT_META_CHANGED*) outcome="NEEDS HUMAN (git hooks/config changed)" ;;
      MERGE=BASE_MOVED*) outcome="NEEDS HUMAN (base branch moved)" ;;
      MERGE=CONFLICT*) outcome="NEEDS HUMAN (merge conflict)" ;;
      *) if [ -n "$issue" ]; then outcome="NEEDS HUMAN (intent issue reported by $issue)"; else outcome="NEEDS HUMAN (see feedback)"; fi ;;
    esac ;;
  *)
    if [ "$timed_out" = yes ]; then
      ts set "$id" status=escalated "feedback.engine=TIMEOUT: the run was stopped after ${TICK_TIMEOUT}s (stage: $(ts get "$id" phase 2>/dev/null))" >/dev/null
    elif [ "$status" = in_progress ]; then
      err=$(sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$LOG" | grep -E 'failed|error' | grep -v 'level=WARN' | tail -1 | cut -c1-300)
      ts set "$id" status=escalated "feedback.engine=engine run ended without a result (exit $rc): ${err:-see $LOG}" >/dev/null
    fi
    outcome="FAILED at $(ts get "$id" phase 2>/dev/null)" ;;
esac

# --- 7. Park an exhausted intent or one with an intent issue (frees the tree for other intents) ----
park=no
case "$outcome" in
  FAILED*) [ "$n" -ge "$MAX_ATTEMPTS" ] && park=yes ;;
  "NEEDS HUMAN (intent issue"*) park=yes ;;
esac
if [ "$park" = yes ] && [ "$meta_bad" = no ]; then
  say "[$id] parking: $(INTENT_META=$meta0 ig park "$id" "$slug" "$base" 2>&1 | tail -1)"
fi

# --- 8. Report and decide -----------------------------------------------------------------------
say "---"
say "intent:   $id"
say "attempt:  $n/$MAX_ATTEMPTS"
say "outcome:  $outcome"
case "$outcome" in
  COMPLETED*) ;;
  *)
    say "verdicts: $(ts get "$id" verdicts 2>/dev/null | tr -d ' \n')"
    ts get "$id" feedback 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{for(const[k,v]of Object.entries(JSON.parse(d)))if(v)console.log(`feedback.${k}: ${String(v).trim().replace(/\s*\n\s*/g," | ").slice(0,400)}`)}catch(e){}})' ;;
esac
say "---"
[ "$meta_bad" = yes ] && stop "git hooks/config changed during the run: needs human (see feedback.engine)"
case "$(ts next "$MAX_ATTEMPTS" | jget action)" in
  run) say "LOOP: CONTINUE" ;;
  done) stop "all intents completed" ;;
  *) stop "blocked: needs human" ;;
esac
