# Trusted launcher for every command task of the delivery workflow (ADR-0001, spike S7).
# A DF command task on Windows runs through cmd.exe and DF escapes double quotes, so the task line carries no quotes:
#   git -C <factory> show <trust>:scripts/launch.sh | sh -s -- <factory> <trust> <meta|-> <project> <run_dir> <repo> <cmd> <task_id> <branch> <base> [args...]
# This file and story-git.sh both come from the factory commit <trust>, never from a working tree, so an agent cannot
# change the code that judges it. Nothing here may read stdin: stdin is this script's own source.
# DF appends a command's stderr to its output; gates compare outputs, so stderr goes to <run_dir>/logs/gates-<task>.log.
F=$1 T=$2 M=$3
[ -n "$F" ] && [ -n "$T" ] && [ $# -ge 10 ] || { echo "launch: usage: <factory> <trust> <meta|-> <project> <run_dir> <repo> <cmd> <task_id> <branch> <base> [args...]"; exit 2; }
shift 3
mkdir -p "$2/logs" && exec 2>>"$2/logs/gates-$5.log"
echo "== $(date -u +%FT%TZ) $4 $*" >&2
s=$(git -C "$F" show "$T:scripts/story-git.sh") && [ -n "$s" ] || { echo "launch: no story-git.sh at factory commit $T" >&2; echo "LAUNCH=NO_TRUSTED_SCRIPT"; exit 1; }
[ "$M" = - ] && M=
FACTORY_REPO=$F FACTORY_TRUST=$T STORY_META=$M exec bash -c "$s" story-git.sh "$@" </dev/null
