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
MODE="${GLIMMER_AGENT_MODE:-read}"

# Glimmer engineering child-process heap
#
# CreatorHub frontend typecheck requires more than Node's normal
# heap limit. exec_shell_command inherits this environment from
# llama-server.
#
# Existing explicit NODE_OPTIONS heap settings take precedence.
GLIMMER_NODE_HEAP_MB="${GLIMMER_NODE_HEAP_MB:-12288}"

if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size="* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${GLIMMER_NODE_HEAP_MB}"
fi

if [ $# -lt 1 ]; then
    echo "Usage:"
    echo "  $0 /path/to/repository"
    echo
    echo "Read-only:"
    echo "  $0 ~/Projects/my-repo"
    echo
    echo "Write mode:"
    echo "  GLIMMER_AGENT_MODE=write $0 ~/Projects/my-repo"
    exit 1
fi

WORKSPACE="$(cd "$1" 2>/dev/null && pwd || true)"

if [ -z "$WORKSPACE" ]; then
    echo "Workspace finnes ikke: $1"
    exit 1
fi

if [ "$WORKSPACE" = "/" ] || [ "$WORKSPACE" = "$HOME" ]; then
    echo "Nekter å bruke et så bredt workspace:"
    echo "$WORKSPACE"
    exit 1
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT er allerede i bruk."
    echo "Stopp standardserveren først:"
    echo "  $ROOT/stop-glimmer.sh"
    exit 1
fi

case "$MODE" in
    read)
        TOOLS="read_file,file_glob_search,grep_search,get_datetime,get_info"
        ;;
    write)
        TOOLS="read_file,file_glob_search,grep_search,exec_shell_command,write_file,edit_file,get_datetime,get_info"
        ;;
    *)
        echo "Ugyldig GLIMMER_AGENT_MODE: $MODE"
        echo "Bruk read eller write."
        exit 1
        ;;
esac

# Glimmer engineering timeout preflight
#
# Write mode requires the patched built-in shell timeout and a
# llama-server binary rebuilt from that source. Fail closed if
# either requirement is not satisfied.
if [ "$MODE" = "write" ]; then
    echo "Engineering preflight:"
    "$ROOT/verify-llama-timeout.sh"
    echo
fi

MCP_ARGS=()

if [ -f "$MCP_CONFIG" ]; then
    "$ROOT/verify-llama-mcp-permissions.sh"
    MCP_ARGS=(--mcp-servers-config "$MCP_CONFIG")
    echo "MCP config: enabled"
else
    echo "MCP config: disabled"
fi

echo
echo "Muse Glimmer Agent"
echo "Workspace: $WORKSPACE"
echo "Mode:      $MODE"
echo "Context:   $CTX"
echo "Port:      $PORT"
echo

cd "$WORKSPACE"

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
