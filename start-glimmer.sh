#!/usr/bin/env bash

set -euo pipefail

ROOT="$HOME/AI/muse-glimmer"
BIN="$ROOT/llama.cpp/build/bin/llama-server"

MODEL="$ROOT/Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf"
MMPROJ="$ROOT/Muse-Glimmer-30B-GGUF/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf"
DFLASH="$ROOT/Muse-Glimmer-30B-GGUF/dflash-Muse-Glimmer-30B-Q4_K_M.gguf"

API_KEY_FILE="$ROOT/config/api-key.txt"
MCP_CONFIG="$ROOT/config/mcp-servers.json"

PORT="${GLIMMER_PORT:-8080}"
CTX="${GLIMMER_CTX:-65536}"
TOOLS="read_file,file_glob_search,grep_search,exec_shell_command,write_file,edit_file,get_datetime,get_info"
GLIMMER_NODE_HEAP_MB="${GLIMMER_NODE_HEAP_MB:-12288}"

if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size="* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${GLIMMER_NODE_HEAP_MB}"
fi

MCP_ARGS=()

echo "Engineering preflight:"
"$ROOT/verify-llama-timeout.sh"

if [ -f "$MCP_CONFIG" ]; then
    echo "MCP preflight:"
    "$ROOT/verify-llama-mcp-permissions.sh"
    MCP_ARGS=(--mcp-servers-config "$MCP_CONFIG")
    echo "MCP config: enabled"
else
    echo "MCP config: disabled"
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT er allerede i bruk."
    echo "Kjør: $ROOT/stop-glimmer.sh"
    exit 1
fi

echo "Starting Muse Glimmer 30B"
echo "Context: $CTX"
echo "Port:    $PORT"
echo "Mode:    control-center write"
echo

exec "$BIN" \
  -m "$MODEL" \
  --mmproj "$MMPROJ" \
  -ngl all \
  -c "$CTX" \
  -np 1 \
  --jinja \
  -fa on \
  --spec-type draft-dflash \
  -md "$DFLASH" \
  -ngld all \
  --spec-draft-n-max 3 \
  --host 127.0.0.1 \
  --port "$PORT" \
  --cors-origins localhost \
  --api-key-file "$API_KEY_FILE" \
  -a muse-glimmer \
  --reasoning-format deepseek \
  --tools "$TOOLS" \
  ${MCP_ARGS[@]+"${MCP_ARGS[@]}"} \
  --temp 1.0 \
  --top-p 0.95 \
  --top-k 64
