#!/usr/bin/env bash
# factory-run.sh: run one story through the delivery workflow, attempt by attempt, from outside the project (ADR-0001).
#   scripts/factory-run.sh <project> <story> [--round N] [--base <branch>] [--publish dry|draft-pr]
#     <story>  task-file id as in the backlog folder, e.g. F01 (file F01-*.md); local id = adapter prefix + id (PA-F01)
# What it does (Peter's orchestrate-tick.sh, re-homed):
#   1. trust = this factory commit; refuses a dirty template or a generated folder that drifts from a fresh render
#   2. project worktree <worktree_root>/<branch> from origin/<base> (created once per round; reused by retries)
#   3. per attempt: copy the rendered workflow + prompts into runs/<project>/<local_id>/r<round>/a<n>/ and run DF there
#   4. judge by the state file: published -> stop; needs_human -> stop; failed -> next attempt (free retry when only the
#      acceptance tests failed to build); attempts exhausted -> park the work as a local WIP commit
# Nothing is written to the project except the story's own changes; run records stay in runs/ (gitignored).
set -uo pipefail
F=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
FW=$(cygpath -m "$F" 2>/dev/null || echo "$F")
DF_BIN=${DF_BIN:-/c/Users/michal.matovcik/Work/LCA/.digital-factory/digital-factory.exe}
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "STOP: $*"; exit 1; }

project=${1:-}; story=${2:-}; shift 2 2>/dev/null || die "usage: factory-run.sh <project> <story> [--round N] [--base B] [--publish dry|draft-pr]"
round=1; base=""; publish=dry
while [ $# -gt 0 ]; do case "$1" in
  --round) round=$2; shift 2 ;; --base) base=$2; shift 2 ;; --publish) publish=$2; shift 2 ;;
  *) die "unknown option $1" ;; esac; done
case "$publish" in dry|draft-pr) ;; *) die "--publish dry|draft-pr" ;; esac
A="$F/projects/$project/adapter.json"; [ -f "$A" ] || die "no adapter for $project"
# {factory} in adapter values = this factory checkout (fixtures live under its runs/).
cfg() { node -e 'const a=require(process.argv[1]);let v=a;for(const k of process.argv[2].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v).split("{factory}").join(process.argv[3]))' "$A" "$1" "$FW"; }

# 1 · trust: the factory commit everything is read from
[ -z "$(git -C "$F" status --porcelain -- scripts workflows prompts schemas "projects/$project")" ] \
  || die "factory template or projects/$project has uncommitted changes; commit them (the gates run the committed copy)"
node "$F/scripts/render.mjs" "$project" --check >/dev/null || die "projects/$project/generated drifts from a fresh render; run render.mjs and commit"
trust=$(git -C "$F" rev-parse HEAD)
# The agents' state CLI: the trusted task-state.js (gates never use this copy; they read the commit).
mkdir -p "$F/runs/.cli" && git -C "$F" show "$trust:scripts/task-state.js" > "$F/runs/.cli/task-state.js" || die "cannot stage the state CLI"

# 2 · story and branch
dir=$(cfg backlog.dir); sf=$(ls "$dir"/"$story"-*.md 2>/dev/null | head -1); [ -n "$sf" ] || die "no task file $story-*.md in $dir"
sf=$(cygpath -m "$sf" 2>/dev/null || echo "$sf")
local_id="$(cfg backlog.local_id_prefix)$story"
slug=$(basename "$sf" .md); slug=${slug#"$story"-}
base=${base:-$(cfg git.story_base)}
branch=$(cfg git.branch_pattern); branch=${branch//\{local_id\}/$local_id}; branch=${branch//\{slug\}/$slug}; branch=${branch//\{round\}/$round}
repo=$(cfg repo.path); wt="$(cfg git.worktree_root)/$branch"
docs_dir=$(cd "$(dirname "$sf")" && git rev-parse --show-toplevel 2>/dev/null); docs_dir=$(cygpath -m "${docs_dir:-$(dirname "$sf")}" 2>/dev/null || echo "$docs_dir")
run="$FW/runs/$project/$local_id/r$round"
for p in "$FW" "$sf" "$wt" "$run" "$docs_dir"; do case "$p" in *" "*) die "path with a space (not allowed, spike S7): $p" ;; esac; done
mkdir -p "$run/logs" "$run/scratch"

if [ ! -d "$wt" ]; then
  git -C "$repo" fetch -q origin "$base" || die "cannot fetch origin/$base"
  git -C "$repo" show-ref -q --verify "refs/heads/$branch" && die "branch $branch exists without its worktree; discard the round first"
  git -C "$repo" worktree add -q -b "$branch" "$wt" "origin/$base" || die "cannot create worktree $wt"
  say "worktree $wt ($branch from origin/$base)"
else
  say "reusing worktree $wt"
fi
[ "$(git -C "$wt" branch --show-current)" = "$branch" ] || die "worktree $wt is not on $branch"
ld=$(cfg git.local_dir); ld=${ld:-.itera}
git -C "$wt" check-ignore -q "$ld/x" || die "$ld/ is not ignored on $base; the story base must contain the setup commit"
mkdir -p "$wt/$ld/scratch"

L() { git -C "$F" show "$trust:scripts/launch.sh" | sh -s -- "$FW" "$trust" "${meta:--}" "$project" "$run" "$wt" "$@" "$local_id" "$branch" "$base"; }
ts() { node "$F/scripts/task-state.js" --state "$run/state.json" "$@"; }
ts set "$local_id" "local_id=$local_id" "story_file=$sf" "branch=$branch" "base=$base" "round=$round" "trust=$trust" >/dev/null

# 3 · attempts
max=$(cfg budget.max_attempts); max_fix=$(cfg budget.max_test_fixes); tmo=$(cfg budget.run_timeout_min)
n=$(ts get "$local_id" attempts 2>/dev/null || echo 0); fixes=$(ts get "$local_id" test_fixes 2>/dev/null || echo 0)
outcome=""
while :; do
  n=$((n + 1)); counted=$((n - fixes))
  [ "$counted" -le "$max" ] || { outcome="EXHAUSTED"; break; }
  ts set "$local_id" "attempts=$n" status=in_progress >/dev/null
  a="$run/a$n"; rm -rf "$a"; mkdir -p "$a"
  cp -R "$F/projects/$project/generated/." "$a/"
  meta=""; meta=$(L git-meta 2>/dev/null) && [ -n "$meta" ] || die "cannot hash the project's git hooks/config"
  story_hash=$(git hash-object --no-filters -- "$sf")
  cp "$sf" "$a/story-before.md"
  pre=run; [ -n "$(ts get "$local_id" base_sha 2>/dev/null)" ] && pre=skip
  say "[$local_id #$n, counted $counted/$max] DF run (preflight=$pre, publish=$publish) → $a"
  ( cd "$a" && timeout "$((tmo * 60 + 300))" "$DF_BIN" workflow run --allow-cross-directory -o "$a/report.json" \
      --set "factory=$FW" --set "trust=$trust" --set "run_dir=$run" --set "repo_path=$wt" \
      --set "task_id=$local_id" --set "local_id=$local_id" --set "branch=$branch" --set "base_branch=$base" \
      --set "attempt=$n" --set "git_meta=$meta" --set "story_file=$sf" --set "story_hash=$story_hash" \
      --set "docs_dir=$docs_dir" --set "preflight=$pre" --set "publish_mode=$publish" \
      --set "state_cli=node $FW/runs/.cli/task-state.js --state $run/state.json" --set "scratch_dir=$wt/$ld/scratch" \
      delivery.yaml </dev/null >"$a/df.log" 2>&1 ); rc=$?
  say "[$local_id #$n] engine exit $rc"
  # after the run: hooks/config and the story file must be unchanged
  [ "$(L git-meta 2>/dev/null)" = "$meta" ] || { ts set "$local_id" status=needs_human "feedback.engine=GIT_META_CHANGED after the run" >/dev/null; outcome="NEEDS_HUMAN git hooks/config changed"; break; }
  [ "$(git hash-object --no-filters -- "$sf")" = "$story_hash" ] || { ts set "$local_id" status=needs_human "feedback.engine=PLAN_CHANGED: the story file changed during the run" >/dev/null; outcome="NEEDS_HUMAN story file changed"; break; }
  status=$(ts get "$local_id" status 2>/dev/null)
  case "$status" in
    pr_ready|pr_open) outcome="PUBLISHED $(ts get "$local_id" pr 2>/dev/null || echo "(dry) $run/pr-body.md")"; break ;;
    needs_human) outcome="NEEDS_HUMAN $(ts get "$local_id" feedback.engine 2>/dev/null | head -c 300)"; break ;;
  esac
  if [ "$(ts get "$local_id" verdicts.tester 2>/dev/null)" = ACCEPTANCE_TESTS_BUILD_FAIL ] && [ "$fixes" -lt "$max_fix" ]; then
    fixes=$((fixes + 1)); ts set "$local_id" "test_fixes=$fixes" >/dev/null
    say "[$local_id #$n] only the acceptance tests failed to build: free retry $fixes/$max_fix for the test author"
  fi
  say "[$local_id #$n] not passed at phase $(ts get "$local_id" phase 2>/dev/null); verdicts $(ts get "$local_id" verdicts 2>/dev/null | tr -d ' \n')"
done

# 4 · park an exhausted story (local WIP commit, never pushed)
[ "$outcome" = EXHAUSTED ] && { ts set "$local_id" status=escalated >/dev/null; say "parking: $(L park 2>&1 | tail -1)"; }
say "---"; say "story:   $local_id ($sf)"; say "branch:  $branch in $wt"; say "run:     $run"
say "outcome: $outcome"
ts get "$local_id" feedback 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{for(const[k,v]of Object.entries(JSON.parse(d)))if(v)console.log(`feedback.${k}: ${String(v).trim().replace(/\s*\n\s*/g," | ").slice(0,300)}`)}catch(e){}})'
case "$outcome" in PUBLISHED*) exit 0 ;; *) exit 1 ;; esac
