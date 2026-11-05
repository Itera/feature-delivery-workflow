#!/usr/bin/env bash
# wfui [workflow] [options] - live dashboard for a workflow found in the current folder.
# Without a name it uses the only workflow here; see `wfui.sh --help` for options.
# wfui run <workflow> [engine args] (or wfui --hub run …) - run it and follow it in the hub; see `wfui.sh run --help`.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
if [ "${1:-}" = run ]; then shift; exec node "$HERE/run.js" "$@"; fi
if [ "${1:-}" = --hub ] && [ "${2:-}" = run ]; then shift 2; exec node "$HERE/run.js" "$@"; fi
exec node "$HERE/server.js" "$@"
