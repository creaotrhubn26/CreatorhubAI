#!/usr/bin/env bash

set -euo pipefail

ROOT="$HOME/AI/muse-glimmer"
BIN="$ROOT/llama.cpp/build/bin/llama-server"
MCP_HEADER="$ROOT/llama.cpp/tools/server/server-mcp.h"
MCP_SOURCE="$ROOT/llama.cpp/tools/server/server-mcp.cpp"
TOOLS_SOURCE="$ROOT/llama.cpp/tools/server/server-tools.cpp"
PATCH_FILE="$ROOT/patches/llama-mcp-tool-permissions.patch"

for file in "$BIN" "$MCP_HEADER" "$MCP_SOURCE" "$TOOLS_SOURCE" "$PATCH_FILE"; do
    if [ ! -f "$file" ]; then
        echo "MCP permission preflight failed: missing $file" >&2
        exit 1
    fi
done

if ! grep -Fq "bool permission_write = true;" "$MCP_HEADER"; then
    echo "MCP permission preflight failed: tool definitions do not fail closed." >&2
    exit 1
fi

if ! grep -Fq 'value("readOnlyHint", false)' "$MCP_SOURCE"; then
    echo "MCP permission preflight failed: readOnlyHint is not classified." >&2
    exit 1
fi

if ! grep -Fq "permission_write = def.permission_write;" "$TOOLS_SOURCE"; then
    echo "MCP permission preflight failed: /tools does not expose MCP permissions." >&2
    exit 1
fi

for source in "$MCP_HEADER" "$MCP_SOURCE" "$TOOLS_SOURCE"; do
    if [ "$source" -nt "$BIN" ]; then
        echo "MCP permission preflight failed: llama-server is older than $source" >&2
        echo "Rebuild llama-server before enabling MCP." >&2
        exit 1
    fi
done

echo "MCP permission boundary: PASS"
