#!/usr/bin/env bash
# Install the intent loop into a project, or update it there. Run from the project (a git repo):
#   <intent-loop>/install.sh [--test "<test command>"]   first install (default test command: npm test)
#   <intent-loop>/install.sh --update [--test "<cmd>"]    newer loop version; keeps the project's test command
# Copies loop/ to .intent-loop/ and skills/intent-orchestrator/ to .claude/skills/intent-orchestrator/,
# sets test_command in .intent-loop/intent-to-merge.yaml, records the version in .intent-loop/VERSION and
# adds the loop's runtime folders to .gitignore. It does not commit: review the changes and commit them on
# the base branch (the loop runs its scripts from that commit).
set -euo pipefail
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
DEST=.intent-loop
SKILL=.claude/skills/intent-orchestrator
WF=$DEST/intent-to-merge.yaml

die() { echo "install: $*" >&2; exit 1; }
update=no; test_cmd=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update) update=yes; shift ;;
    --test) [ $# -ge 2 ] || die "--test needs a command"; test_cmd=$2; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

git rev-parse --show-toplevel >/dev/null 2>&1 || die "run it from inside the project's git repo"
cd "$(git rev-parse --show-toplevel)"
[ "$(pwd -P)" != "$SRC" ] || die "run it from the project, not from the intent-loop repo"
case "$test_cmd" in *$'\n'*) die "--test must be a single line" ;; esac

if [ -e "$DEST" ] || [ -e "$SKILL" ]; then
  [ "$update" = yes ] || die "$DEST already exists; use --update to install a newer version"
  # Never overwrite local edits to the loop: they must be committed (and are then visible in the diff) or reverted.
  [ -z "$(git status --porcelain -- "$DEST" "$SKILL")" ] \
    || die "uncommitted changes in $DEST or $SKILL; commit or revert them first"
  if [ -z "$test_cmd" ] && [ -f "$WF" ]; then
    test_cmd=$(sed -n 's/^    test_command: //p' "$WF" | head -1)
  fi
  rm -rf "$DEST" "$SKILL"
elif [ "$update" = yes ]; then
  die "$DEST is not installed yet; run without --update"
fi
test_cmd=${test_cmd:-npm test}

mkdir -p "$DEST" "$(dirname "$SKILL")"
cp -R "$SRC/loop/." "$DEST/"
cp -R "$SRC/skills/intent-orchestrator" "$SKILL"
chmod +x "$DEST"/*.sh "$DEST/task-state.js"

grep -q '^    test_command: ' "$WF" || die "test_command not found in $WF"
TC=$test_cmd perl -pi -e 's/^    test_command: .*$/    test_command: $ENV{TC}/' "$WF"

version=$(git -C "$SRC" describe --tags --always --dirty 2>/dev/null || echo unknown)
printf '%s\n' "$version" > "$DEST/VERSION"

added=()
touch .gitignore
for p in .task-state/ .digital-factory/ .digital-factory-outputs/ .copilot-cache/ .code-compass/; do
  grep -qxF "$p" .gitignore || { printf '%s\n' "$p" >> .gitignore; added+=("$p"); }
done

echo "intent loop $version $([ "$update" = yes ] && echo updated || echo installed) in $(pwd -P)"
echo "  $DEST/                         scripts, workflow, prompts (test_command: $test_cmd)"
echo "  $SKILL/  /intent-orchestrator skill"
[ ${#added[@]} -eq 0 ] || echo "  .gitignore: added ${added[*]}"
echo "next:"
echo "  1. review and commit on the base branch:  git add $DEST $SKILL .gitignore && git commit -m 'intent loop $version'"
[ -n "$(git config user.email || true)" ] || echo "  2. set a git identity for the loop's commits:  git config user.name ... && git config user.email ..."
echo "  run:  $DEST/tick-loop.sh   (all intents; $DEST/orchestrate-tick.sh runs one)"
