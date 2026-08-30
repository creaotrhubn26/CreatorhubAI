#!/usr/bin/env bash
set -euo pipefail
umask 077

STATE_ROOT=/run/glimmer-worker
MODEL_ROOT=/workspace/models
MODEL_KEY="$STATE_ROOT/model-api.key"
MODEL_CONFIG="$STATE_ROOT/models.json"
READY_MARKER="$STATE_ROOT/model.ready"
CTX="${GLIMMER_CONTEXT_TOKENS:-65536}"
DOWNLOAD_PID=""
LLAMA_PID=""
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

MODEL_PATH="$MODEL_ROOT/model.$GLIMMER_MODEL_SHA256.gguf"
MMPROJ_PATH="$MODEL_ROOT/mmproj.$GLIMMER_MMPROJ_SHA256.gguf"
DFLASH_PATH="$MODEL_ROOT/dflash.$GLIMMER_DFLASH_SHA256.gguf"

install -d -o glimmer -g glimmer -m 0700 "$STATE_ROOT" "$MODEL_ROOT" /workspace/recovery
rm -f "$READY_MARKER"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local pid
  local index
  local pids=("$DOWNLOAD_PID" "$LLAMA_PID" "$WORKER_PID")
  local killers=()
  for pid in "${pids[@]}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    if [ -n "$pid" ]; then
      (
        sleep 5
        kill -KILL "$pid" 2>/dev/null || true
      ) >/dev/null 2>&1 &
      killers+=("$!")
    else
      killers+=("")
    fi
  done
  for index in "${!pids[@]}"; do
    pid="${pids[$index]}"
    if [ -n "$pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
    if [ -n "${killers[$index]}" ]; then
      kill "${killers[$index]}" 2>/dev/null || true
      wait "${killers[$index]}" 2>/dev/null || true
    fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

process_alive() {
  local pid="$1"
  local process_record
  local process_state
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/stat" ]; then
    process_record="$(<"/proc/$pid/stat")"
    process_state="${process_record##*) }"
    process_state="${process_state%% *}"
  else
    process_state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
  fi
  [ -z "$process_state" ] && return 0
  [[ "$process_state" != Z* && "$process_state" != X* ]]
}

gosu glimmer python3 /opt/glimmer/runpod_worker.py \
  >"$STATE_ROOT/worker.log" 2>&1 &
WORKER_PID=$!

WORKER_LISTENING=false
for _ in $(seq 1 100); do
  if ! process_alive "$WORKER_PID"; then
    echo '{"event":"startup_failed","reason":"worker_exited"}' >&2
    exit 5
  fi
  if python3 -c 'import json; from urllib.request import urlopen; value=json.load(urlopen("http://127.0.0.1:4318/v1/health", timeout=0.5)); assert value.get("ready") is False and value.get("workerState") == "bootstrapping" and (value.get("model") or {}).get("ready") is False' >/dev/null 2>&1; then
    WORKER_LISTENING=true
    break
  fi
  sleep 0.1
done
if [ "$WORKER_LISTENING" != true ]; then
  echo '{"event":"startup_failed","reason":"worker_listener_timeout"}' >&2
  exit 5
fi

HOST_ARGS=()
IFS=',' read -r -a HOSTS <<< "$GLIMMER_ARTIFACT_HOSTS"
for host in "${HOSTS[@]}"; do
  HOST_ARGS+=(--allowed-host "$host")
done

run_download() {
  gosu glimmer python3 /opt/glimmer/docker/runpod/fetch_artifact.py "$@" &
  DOWNLOAD_PID=$!
  while process_alive "$DOWNLOAD_PID"; do
    if ! process_alive "$WORKER_PID"; then
      echo '{"event":"startup_failed","reason":"worker_exited"}' >&2
      return 5
    fi
    sleep 0.2
  done
  if wait "$DOWNLOAD_PID"; then
    DOWNLOAD_PID=""
  else
    local status=$?
    DOWNLOAD_PID=""
    return "$status"
  fi
  if ! process_alive "$WORKER_PID"; then
    echo '{"event":"startup_failed","reason":"worker_exited"}' >&2
    return 5
  fi
}

run_download --url "$GLIMMER_MODEL_URL" --sha256 "$GLIMMER_MODEL_SHA256" \
  --output "$MODEL_PATH" "${HOST_ARGS[@]}"
run_download --url "$GLIMMER_MMPROJ_URL" --sha256 "$GLIMMER_MMPROJ_SHA256" \
  --output "$MMPROJ_PATH" "${HOST_ARGS[@]}"
run_download --url "$GLIMMER_DFLASH_URL" --sha256 "$GLIMMER_DFLASH_SHA256" \
  --output "$DFLASH_PATH" "${HOST_ARGS[@]}"

gosu glimmer /opt/glimmer/bin/llama-server \
  -m "$MODEL_PATH" \
  --mmproj "$MMPROJ_PATH" \
  -ngl all -c "$CTX" -np 1 --jinja -fa on \
  --spec-type draft-dflash -md "$DFLASH_PATH" -ngld all \
  --spec-draft-n-max 3 --host 127.0.0.1 --port 8080 \
  --api-key-file "$MODEL_KEY" -a muse-glimmer \
  --reasoning-format deepseek \
  --tools read_file,file_glob_search,grep_search,exec_shell_command,write_file,edit_file,get_datetime,get_info \
  --temp 1.0 --top-p 0.95 --top-k 64 \
  >"$STATE_ROOT/llama.log" 2>&1 &
LLAMA_PID=$!

for _ in $(seq 1 180); do
  if ! process_alive "$WORKER_PID"; then
    echo '{"event":"startup_failed","reason":"worker_exited"}' >&2
    exit 5
  fi
  if ! process_alive "$LLAMA_PID"; then
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

wait "$WORKER_PID"
