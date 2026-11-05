# platform.sh: the only OS-specific code of the factory. Windows (Git Bash) is the default; macOS and Linux are adapter
# values (`platform.os`), not forks. Sourced by the driver from the working tree, and by story-git.sh from the factory
# commit (eval of `git show <trust>:scripts/platform.sh`), so the gates use the trusted copy.
#   PLAT_OS        windows | macos | linux   (adapter platform.os; else detected)
#   PLAT_OPEN_CMD  command that opens a URL   (adapter platform.open_cmd; else per OS)
# Functions: plat_detect, plat_path, plat_open, plat_timeout, plat_kill_pid, plat_df_bin.

plat_detect() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    Darwin) echo macos ;;
    *) echo linux ;;
  esac
}
PLAT_OS=${PLAT_OS:-$(plat_detect)}

# A path as the engine and other native tools expect it: C:/x/y on Windows, unchanged elsewhere.
plat_path() {
  if [ "$PLAT_OS" = windows ] && command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

# Open a URL in the default browser; never fails the caller.
plat_open() {
  if [ -n "${PLAT_OPEN_CMD:-}" ]; then $PLAT_OPEN_CMD "$1" >/dev/null 2>&1 || true; return 0; fi
  case "$PLAT_OS" in
    windows) explorer.exe "$1" >/dev/null 2>&1 ;;   # exit code is always 1
    macos)   open "$1" >/dev/null 2>&1 ;;
    *)       xdg-open "$1" >/dev/null 2>&1 ;;
  esac
  return 0
}

# plat_timeout <seconds> <cmd...>: GNU timeout (Git Bash, Linux), gtimeout (macOS with coreutils), else a watchdog.
# Exit 124 on timeout, like timeout(1).
plat_timeout() {
  local s=$1; shift
  if timeout --version >/dev/null 2>&1; then timeout "$s" "$@"; return; fi   # not Windows' own timeout.exe
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$s" "$@"; return; fi
  "$@" & local p=$!
  ( sleep "$s"; kill -TERM "$p" 2>/dev/null && { sleep 10; kill -KILL "$p" 2>/dev/null; } ) >/dev/null 2>&1 & local w=$!
  wait "$p"; local rc=$?
  if kill -0 "$w" 2>/dev/null; then kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; else rc=124; fi
  return $rc
}

# plat_kill_pid <pid>: stop a process (and its children) an agent recorded, but only a dev server we expect
# (node, dotnet, a project executable). Returns 0 when it stopped one.
plat_kill_pid() {
  local pid=$1 img
  if [ "$PLAT_OS" = windows ]; then
    img=$(tasklist.exe //FI "PID eq $pid" //NH //FO CSV 2>/dev/null | head -1 | cut -d, -f1 | tr -d '"')
    case "$img" in node.exe|dotnet.exe|LCA.*.exe) taskkill.exe //PID "$pid" //T //F >/dev/null 2>&1 ;; *) return 1 ;; esac
  else
    img=$(ps -p "$pid" -o comm= 2>/dev/null); img=${img##*/}
    case "$img" in
      node|dotnet|LCA.*)
        pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null || return 1
        sleep 2; kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null; return 0 ;;
      *) return 1 ;;
    esac
  fi
}

# plat_df_bin [adapter value]: the engine binary. Order: $DF_BIN, the adapter's platform.df_bin, PATH, ~/.digital-factory.
plat_df_bin() {
  local exe=digital-factory c
  [ "$PLAT_OS" = windows ] && exe=digital-factory.exe
  for c in "${DF_BIN:-}" "${1:-}" "$(command -v "$exe" 2>/dev/null)" "$HOME/.digital-factory/$exe"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
