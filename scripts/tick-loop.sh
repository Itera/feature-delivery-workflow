#!/usr/bin/env bash
# Run orchestrator ticks one after another until the loop is done or needs a human.
# Run from the target repo (like orchestrate-tick.sh):  tick-loop.sh [intents-folder]
# Each tick runs one intent through intent-to-merge and ends with LOOP: CONTINUE or LOOP: STOP (<reason>);
# this starts the next tick only after LOOP: CONTINUE. The intents folder is only needed for the first
# tick (the state file remembers it). Env is passed through to orchestrate-tick.sh (MAX_ATTEMPTS, ...).
set -uo pipefail
TICK=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/orchestrate-tick.sh
n=1
while :; do
  out=$(mktemp)
  "$TICK" "$@" | tee "$out"
  last=$(grep '^LOOP: ' "$out" | tail -1); rm -f "$out"
  [ "$last" = "LOOP: CONTINUE" ] || break
  n=$((n + 1))
  echo "=== tick $n ==="
done
[ -n "$last" ] || { echo "tick-loop: the tick ended without a LOOP: line" >&2; exit 1; }
