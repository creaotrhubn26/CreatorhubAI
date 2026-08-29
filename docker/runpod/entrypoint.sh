#!/usr/bin/env bash
set -euo pipefail
umask 077

STATE_ROOT=/run/glimmer-worker
MODEL_ROOT=/workspace/models
MODEL_KEY="$STATE_ROOT/model-api.key"
MODEL_CONFIG="$STATE_ROOT/models.json"
READY_MARKER="$STATE_ROOT/model.ready"
CTX="${GLIMMER_CONTEXT_TOKENS:-65536}"
WORKER_PID=""

case "$CTX" in
  65536|131072) ;;
  *) echo '{"event":"startup_failed","reason":"invalid_context"}' >&2; exit 2 ;;
esac

: "${GLIMMER_WORKER_BOOTSTRAP_TOKEN:?worker bootstrap token is required}"
: "${GLIMMER_MODEL_URL:?model URL is required}"
: "${GLIMMER_MODEL_SHA256:?model SHA-256 is required}"
: "${GLIMMER_MMPROJ_URL:?mmproj URL is required}"
: "${GLIMMER_MMPROJ_SHA256:?mmproj SHA-256 is required}"
: "${GLIMMER_DFLASH_URL:?draft model URL is required}"
: "${GLIMMER_DFLASH_SHA256:?draft model SHA-256 is required}"
: "${GLIMMER_ARTIFACT_HOSTS:?artifact host allowlist is required}"

install -d -o glimmer -g glimmer -m 0700 "$STATE_ROOT" "$MODEL_ROOT" /workspace/recovery
rm -f "$READY_MARKER"
HOST_ARGS=()
IFS=',' read -r -a HOSTS <<< "$GLIMMER_ARTIFACT_HOSTS"
for host in "${HOSTS[@]}"; do
  HOST_ARGS+=(--allowed-host "$host")
done

gosu glimmer python3 /opt/glimmer/docker/runpod/fetch_artifact.py \
  --url "$GLIMMER_MODEL_URL" --sha256 "$GLIMMER_MODEL_SHA256" \
  --output "$MODEL_ROOT/model.gguf" "${HOST_ARGS[@]}"
gosu glimmer python3 /opt/glimmer/docker/runpod/fetch_artifact.py \
  --url "$GLIMMER_MMPROJ_URL" --sha256 "$GLIMMER_MMPROJ_SHA256" \
  --output "$MODEL_ROOT/mmproj.gguf" "${HOST_ARGS[@]}"
gosu glimmer python3 /opt/glimmer/docker/runpod/fetch_artifact.py \
  --url "$GLIMMER_DFLASH_URL" --sha256 "$GLIMMER_DFLASH_SHA256" \
  --output "$MODEL_ROOT/dflash.gguf" "${HOST_ARGS[@]}"

python3 - "$MODEL_KEY" "$MODEL_CONFIG" <<'PY'
import json
import secrets
import sys
from pathlib import Path

key_path, config_path = map(Path, sys.argv[1:])
key_path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
key_path.chmod(0o600)
model = {
    "id": "worker-local",
    "label": "RunPod Glimmer",
    "baseUrl": "http://127.0.0.1:8080",
    "modelId": "muse-glimmer",
    "apiKeyFile": str(key_path),
}
config = {
    "version": 1,
    "models": [model],
    "roles": {role: model["id"] for role in ("engineer", "architect", "consult", "vision")},
    "routing": {
        "enabled": False,
        "highRisk": {},
        "criticProviderId": None,
        "requireIndependentCritic": False,
    },
}
config_path.write_text(json.dumps(config, sort_keys=True, separators=(",", ":")), encoding="utf-8")
config_path.chmod(0o600)
PY
chown glimmer:glimmer "$MODEL_KEY" "$MODEL_CONFIG"

export GLIMMER_API_KEY_FILE="$MODEL_KEY"
export GLIMMER_MODEL_CONFIG="$MODEL_CONFIG"
export GLIMMER_URL=http://127.0.0.1:8080

gosu glimmer /opt/glimmer/bin/llama-server \
  -m "$MODEL_ROOT/model.gguf" \
  --mmproj "$MODEL_ROOT/mmproj.gguf" \
  -ngl all -c "$CTX" -np 1 --jinja -fa on \
  --spec-type draft-dflash -md "$MODEL_ROOT/dflash.gguf" -ngld all \
  --spec-draft-n-max 3 --host 127.0.0.1 --port 8080 \
  --api-key-file "$MODEL_KEY" -a muse-glimmer \
  --reasoning-format deepseek \
  --tools read_file,file_glob_search,grep_search,exec_shell_command,write_file,edit_file,get_datetime,get_info \
  --temp 1.0 --top-p 0.95 --top-k 64 \
  >"$STATE_ROOT/llama.log" 2>&1 &
LLAMA_PID=$!

cleanup() {
  if [ -n "$WORKER_PID" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  kill "$LLAMA_PID" 2>/dev/null || true
  wait "$LLAMA_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 180); do
  if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
    echo '{"event":"startup_failed","reason":"llama_exited"}' >&2
    exit 3
  fi
  if python3 /opt/glimmer/docker/runpod/healthcheck.py >/dev/null 2>&1; then
    gosu glimmer touch "$READY_MARKER"
    break
  fi
  sleep 2
done
test -f "$READY_MARKER" || { echo '{"event":"startup_failed","reason":"readiness_timeout"}' >&2; exit 4; }

gosu glimmer python3 /opt/glimmer/runpod_worker.py &
WORKER_PID=$!
wait "$WORKER_PID"
