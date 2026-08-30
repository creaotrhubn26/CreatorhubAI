#!/usr/bin/env bash
set -euo pipefail
umask 077

STATE_ROOT=/run/glimmer-worker
MODEL_ROOT=/workspace/models
RECOVERY_ROOT=/workspace/recovery
MODEL_KEY="$STATE_ROOT/model-api.key"
MODEL_CONFIG="$STATE_ROOT/models.json"
READY_MARKER="$STATE_ROOT/model.ready"
BOOTSTRAP_STATUS_TOOL=/opt/glimmer/docker/runpod/bootstrap_status.py
CTX="${GLIMMER_CONTEXT_TOKENS:-65536}"
PREWARM_ONLY="${GLIMMER_PREWARM_ONLY:-0}"
DOWNLOAD_PID=""
LLAMA_PID=""
WORKER_PID=""
BOOTSTRAP_STATUS_FILE=""
BOOTSTRAP_FAILURE_CODE=""
BOOTSTRAP_TERMINAL=false

if ! [[ "${GLIMMER_LEASE_ID:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
  echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
  exit 2
fi
BOOTSTRAP_STATUS_FILE="$RECOVERY_ROOT/bootstrap/$GLIMMER_LEASE_ID/status.json"

install -d -o glimmer -g glimmer -m 0700 "$STATE_ROOT" "$MODEL_ROOT" "$RECOVERY_ROOT"
if ! gosu glimmer python3 "$BOOTSTRAP_STATUS_TOOL" \
  --path "$BOOTSTRAP_STATUS_FILE" --lease-id "$GLIMMER_LEASE_ID" initialize; then
  exit 6
fi

status_update() {
  if ! gosu glimmer python3 "$BOOTSTRAP_STATUS_TOOL" \
    --path "$BOOTSTRAP_STATUS_FILE" --lease-id "$GLIMMER_LEASE_ID" update "$@"; then
    BOOTSTRAP_FAILURE_CODE=status_persistence_failed
    return 6
  fi
}

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
  if [ "$BOOTSTRAP_TERMINAL" != true ]; then
    local failure_code="${BOOTSTRAP_FAILURE_CODE:-unexpected_failure}"
    gosu glimmer python3 "$BOOTSTRAP_STATUS_TOOL" \
      --path "$BOOTSTRAP_STATUS_FILE" --lease-id "$GLIMMER_LEASE_ID" fail \
      --failure-code "$failure_code" --exit-code "$status" || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'BOOTSTRAP_FAILURE_CODE=bootstrap_interrupted; exit 130' INT
trap 'BOOTSTRAP_FAILURE_CODE=bootstrap_interrupted; exit 143' TERM
rm -f "$READY_MARKER"

case "$PREWARM_ONLY" in
  0|1) ;;
  *)
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
    ;;
esac
for name in \
  GLIMMER_MODEL_URL GLIMMER_MODEL_SHA256 \
  GLIMMER_MMPROJ_URL GLIMMER_MMPROJ_SHA256 \
  GLIMMER_DFLASH_URL GLIMMER_DFLASH_SHA256 \
  GLIMMER_ARTIFACT_HOSTS; do
  if [ -z "${!name:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
done
if [ "$PREWARM_ONLY" = 1 ]; then
  if ! [[ "${GLIMMER_PREWARM_EXPECTED_BUILD_ID:-}" =~ ^r2-[a-f0-9]{12}$ ]] || \
    [ "$GLIMMER_PREWARM_EXPECTED_BUILD_ID" != "${GLIMMER_WORKER_BUILD_ID:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
fi
for name in GLIMMER_MODEL_SHA256 GLIMMER_MMPROJ_SHA256 GLIMMER_DFLASH_SHA256; do
  if ! [[ "${!name}" =~ ^[a-f0-9]{64}$ ]]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
done
if [ "$PREWARM_ONLY" != 1 ]; then
  if [ -z "${GLIMMER_WORKER_BOOTSTRAP_TOKEN:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
  case "$CTX" in
    65536|131072) ;;
    *)
      BOOTSTRAP_FAILURE_CODE=configuration_invalid
      echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
      exit 2
      ;;
  esac
fi
MODEL_PATH="$MODEL_ROOT/model.$GLIMMER_MODEL_SHA256.gguf"
MMPROJ_PATH="$MODEL_ROOT/mmproj.$GLIMMER_MMPROJ_SHA256.gguf"
DFLASH_PATH="$MODEL_ROOT/dflash.$GLIMMER_DFLASH_SHA256.gguf"

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

if [ "$PREWARM_ONLY" != 1 ]; then
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
  export GLIMMER_BOOTSTRAP_STATUS_FILE="$BOOTSTRAP_STATUS_FILE"

  status_update --stage worker_starting
  gosu glimmer python3 /opt/glimmer/runpod_worker.py \
    >"$STATE_ROOT/worker.log" 2>&1 &
  WORKER_PID=$!

  WORKER_LISTENING=false
  for _ in $(seq 1 100); do
    if ! process_alive "$WORKER_PID"; then
      BOOTSTRAP_FAILURE_CODE=worker_start_failed
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
    BOOTSTRAP_FAILURE_CODE=worker_start_failed
    echo '{"event":"startup_failed","reason":"worker_listener_timeout"}' >&2
    exit 5
  fi
  status_update --stage worker_listening
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
    if [ "$PREWARM_ONLY" != 1 ] && ! process_alive "$WORKER_PID"; then
      BOOTSTRAP_FAILURE_CODE=worker_start_failed
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
  if [ "$PREWARM_ONLY" != 1 ] && ! process_alive "$WORKER_PID"; then
    BOOTSTRAP_FAILURE_CODE=worker_start_failed
    echo '{"event":"startup_failed","reason":"worker_exited"}' >&2
    return 5
  fi
}

fetch_artifact() {
  local kind="$1"
  local url="$2"
  local sha256="$3"
  local output="$4"
  local status
  status_update --stage artifact_preparing \
    --artifact-kind "$kind" --artifact-phase locking
  if run_download --url "$url" --sha256 "$sha256" --output "$output" \
    --status-file "$BOOTSTRAP_STATUS_FILE" --lease-id "$GLIMMER_LEASE_ID" \
    --artifact-kind "$kind" "${HOST_ARGS[@]}"; then
    return 0
  else
    status=$?
  fi
  case "$status" in
    5) BOOTSTRAP_FAILURE_CODE=worker_start_failed ;;
    6) BOOTSTRAP_FAILURE_CODE=status_persistence_failed ;;
    20) BOOTSTRAP_FAILURE_CODE=artifact_checksum_failed ;;
    *) BOOTSTRAP_FAILURE_CODE=artifact_download_failed ;;
  esac
  echo '{"event":"startup_failed","reason":"artifact_fetch_failed"}' >&2
  return "$status"
}

fetch_artifact model "$GLIMMER_MODEL_URL" "$GLIMMER_MODEL_SHA256" "$MODEL_PATH"
fetch_artifact mmproj "$GLIMMER_MMPROJ_URL" "$GLIMMER_MMPROJ_SHA256" "$MMPROJ_PATH"
fetch_artifact draft "$GLIMMER_DFLASH_URL" "$GLIMMER_DFLASH_SHA256" "$DFLASH_PATH"

if [ "$PREWARM_ONLY" = 1 ]; then
  status_update --stage ready --outcome ready
  printf 'GLIMMER_PREWARM_READY %s\n' "$GLIMMER_LEASE_ID"
  BOOTSTRAP_TERMINAL=true
  exit 0
fi

status_update --stage model_starting
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

status_update --stage model_healthcheck
for _ in $(seq 1 180); do
  if ! process_alive "$WORKER_PID"; then
    BOOTSTRAP_FAILURE_CODE=worker_start_failed
    echo '{"event":"startup_failed","reason":"worker_exited"}' >&2
    exit 5
  fi
  if ! process_alive "$LLAMA_PID"; then
    BOOTSTRAP_FAILURE_CODE=model_start_failed
    echo '{"event":"startup_failed","reason":"llama_exited"}' >&2
    exit 3
  fi
  if python3 /opt/glimmer/docker/runpod/healthcheck.py >/dev/null 2>&1; then
    status_update --stage ready --outcome ready
    gosu glimmer touch "$READY_MARKER"
    BOOTSTRAP_TERMINAL=true
    break
  fi
  sleep 2
done
if [ ! -f "$READY_MARKER" ]; then
  BOOTSTRAP_FAILURE_CODE=model_healthcheck_failed
  echo '{"event":"startup_failed","reason":"readiness_timeout"}' >&2
  exit 4
fi

wait "$WORKER_PID"
