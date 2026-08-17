#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/AI/muse-glimmer"

SOURCE="$ROOT/llama.cpp/tools/server/server-tools.cpp"
BIN="$ROOT/llama.cpp/build/bin/llama-server"
PATCH="$ROOT/patches/llama-exec-shell-timeout-1200.patch"

echo "Glimmer llama.cpp timeout verification"
echo

if [ ! -f "$SOURCE" ]; then
    echo "SOURCE: FAIL"
    echo "Missing:"
    echo "$SOURCE"
    exit 1
fi

if grep -Eq \
  'SERVER_TOOL_EXEC_SHELL_COMMAND_MAX_TIMEOUT[[:space:]]*=[[:space:]]*1200;' \
  "$SOURCE"
then
    echo "SOURCE: PASS"
    echo "exec_shell_command max timeout = 1200 seconds"

elif grep -Eq \
  'SERVER_TOOL_EXEC_SHELL_COMMAND_MAX_TIMEOUT[[:space:]]*=[[:space:]]*60;' \
  "$SOURCE"
then
    echo "SOURCE: FAIL"
    echo "llama.cpp is using the 60-second shell timeout."
    echo
    echo "Stored patch:"
    echo "$PATCH"
    echo
    echo "Review/reapply the patch and rebuild llama-server."
    exit 2

else
    echo "SOURCE: UNKNOWN"
    echo "The upstream timeout implementation appears to have changed."
    echo
    echo "Do NOT automatically apply the old patch."
    echo "Inspect:"
    echo "$SOURCE"
    exit 3
fi

echo

if [ ! -x "$BIN" ]; then
    echo "BINARY: FAIL"
    echo "Missing or non-executable:"
    echo "$BIN"
    exit 4
fi

echo "BINARY: present"

stat -f "Source modified: %Sm" \
  -t "%Y-%m-%d %H:%M:%S" \
  "$SOURCE"

stat -f "Binary built:    %Sm" \
  -t "%Y-%m-%d %H:%M:%S" \
  "$BIN"

if [ "$BIN" -ot "$SOURCE" ]; then
    echo
    echo "BINARY: STALE"
    echo "llama-server is older than server-tools.cpp."
    echo
    echo "Rebuild before starting Glimmer Engineering:"
    echo
    echo "  cd \"$ROOT/llama.cpp\""
    echo "  cmake --build build --target llama-server -j \"\$(sysctl -n hw.ncpu)\""
    exit 5
fi

echo "BINARY: PASS"
echo

if [ ! -s "$PATCH" ]; then
    echo "PATCH BACKUP: FAIL"
    echo "Stored timeout patch is missing or empty:"
    echo "$PATCH"
    exit 6
fi

echo "PATCH BACKUP: PASS"
echo
echo "TIMEOUT PREFLIGHT: PASS"
