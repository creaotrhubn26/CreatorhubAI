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
CACHE_MANIFEST_TOOL=/opt/glimmer/docker/runpod/cache_manifest.py
COORDINATOR_CALLBACK_TOOL=/opt/glimmer/docker/runpod/coordinator_callback.py
RECEIPT_ROOT="$STATE_ROOT/artifact-receipts"
CTX="${GLIMMER_CONTEXT_TOKENS:-65536}"
PREWARM_ONLY="${GLIMMER_PREWARM_ONLY:-0}"
REQUIRE_READY_CACHE="${GLIMMER_REQUIRE_READY_CACHE:-0}"
CACHE_SIGNING_PRIVATE_KEY=""
DOWNLOAD_PID=""
LLAMA_PID=""
WORKER_PID=""
BOOTSTRAP_STATUS_FILE=""
BOOTSTRAP_STATUS_MIRROR_FILE=""
BOOTSTRAP_FAILURE_CODE=""
BOOTSTRAP_TERMINAL=false
STATUS_RUNNER=(gosu glimmer)

if ! [[ "${GLIMMER_LEASE_ID:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
  echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
  exit 2
fi
BOOTSTRAP_STATUS_FILE="$STATE_ROOT/bootstrap/$GLIMMER_LEASE_ID/status.json"
BOOTSTRAP_STATUS_MIRROR_FILE="$RECOVERY_ROOT/bootstrap/$GLIMMER_LEASE_ID/status.json"

case "$PREWARM_ONLY" in
  0|1) ;;
  *)
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
    ;;
esac
case "$REQUIRE_READY_CACHE" in
  0|1) ;;
  *)
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
    ;;
esac

# Directories on the network volume cannot rely on chown: the volume may
# refuse or remap ownership changes (NFS idmapping/root squash). Create them,
# set the mode (which the volume honours), and treat ownership as best
# effort. Local tmpfs paths keep strict install semantics.
volume_dir() {
  local owner="$1" mode="$2"
  shift 2
  local dir
  for dir in "$@"; do
    mkdir -p "$dir"
    chown "$owner:$owner" "$dir" 2>/dev/null || true
    chmod "$mode" "$dir"
  done
}

install -d -o glimmer -g glimmer -m 0700 "$STATE_ROOT"
volume_dir glimmer 0755 "$RECOVERY_ROOT" "$RECOVERY_ROOT/bootstrap"
USE_HASH_RECEIPTS=false
if [ "$REQUIRE_READY_CACHE" = 1 ]; then
  if [ "$PREWARM_ONLY" = 1 ]; then
    # Ready-cache prewarm writes root-owned model artifacts.  Its progress
    # reporter must own the private status inode too; bootstrap_status rejects
    # cross-UID writers by design.
    STATUS_RUNNER=(env)
    install -d -o root -g root -m 0700 "$STATE_ROOT"
    volume_dir root 0700 "$MODEL_ROOT"
    install -d -o root -g root -m 0700 "$RECEIPT_ROOT"
    USE_HASH_RECEIPTS=true
  else
    volume_dir root 0555 "$MODEL_ROOT"
  fi
else
  # 0755, not 0700: the volume may report the directory as owned by another
  # uid (see volume_dir), and the glimmer-run model server still needs
  # traversal. Model weights are not secrets inside this single-tenant Pod.
  volume_dir glimmer 0755 "$MODEL_ROOT"
fi
if ! "${STATUS_RUNNER[@]}" python3 "$BOOTSTRAP_STATUS_TOOL" \
  --path "$BOOTSTRAP_STATUS_FILE" --mirror-path "$BOOTSTRAP_STATUS_MIRROR_FILE" \
  --lease-id "$GLIMMER_LEASE_ID" initialize; then
  exit 6
fi

status_update() {
  if ! "${STATUS_RUNNER[@]}" python3 "$BOOTSTRAP_STATUS_TOOL" \
    --path "$BOOTSTRAP_STATUS_FILE" --mirror-path "$BOOTSTRAP_STATUS_MIRROR_FILE" \
    --lease-id "$GLIMMER_LEASE_ID" update "$@"; then
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
    "${STATUS_RUNNER[@]}" python3 "$BOOTSTRAP_STATUS_TOOL" \
      --path "$BOOTSTRAP_STATUS_FILE" --mirror-path "$BOOTSTRAP_STATUS_MIRROR_FILE" \
      --lease-id "$GLIMMER_LEASE_ID" fail \
      --failure-code "$failure_code" --exit-code "$status" || true
    if [ "$PREWARM_ONLY" = 1 ] && [ "$REQUIRE_READY_CACHE" = 1 ] && \
      [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ] && \
      [ -n "${GLIMMER_CACHE_KEY:-}" ]; then
      python3 "$COORDINATOR_CALLBACK_TOOL" cache-failed \
        --cache-key "$GLIMMER_CACHE_KEY" --failure-code "$failure_code" || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'BOOTSTRAP_FAILURE_CODE=bootstrap_interrupted; exit 130' INT
trap 'BOOTSTRAP_FAILURE_CODE=bootstrap_interrupted; exit 143' TERM
rm -f "$READY_MARKER"

for name in GLIMMER_MODEL_SHA256 GLIMMER_MMPROJ_SHA256 GLIMMER_DFLASH_SHA256; do
  if [ -z "${!name:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
done
if [ "$REQUIRE_READY_CACHE" != 1 ] || [ "$PREWARM_ONLY" = 1 ]; then
  for name in \
    GLIMMER_MODEL_URL GLIMMER_MMPROJ_URL GLIMMER_DFLASH_URL \
    GLIMMER_ARTIFACT_HOSTS; do
    if [ -z "${!name:-}" ]; then
      BOOTSTRAP_FAILURE_CODE=configuration_invalid
      echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
      exit 2
    fi
  done
fi
if [ "$REQUIRE_READY_CACHE" = 1 ]; then
  if [ -z "${GLIMMER_CACHE_VOLUME_ID:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
  if [ "$PREWARM_ONLY" = 1 ] && [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" != 1 ]; then
    CACHE_SIGNING_PRIVATE_KEY="${GLIMMER_CACHE_SIGNING_PRIVATE_KEY:-}"
    unset GLIMMER_CACHE_SIGNING_PRIVATE_KEY
    if [ -z "$CACHE_SIGNING_PRIVATE_KEY" ]; then
      BOOTSTRAP_FAILURE_CODE=configuration_invalid
      echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
      exit 2
    fi
  elif [ -z "${GLIMMER_CACHE_SIGNING_PUBLIC_KEY:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
fi
if [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ]; then
  if [ -z "${GLIMMER_COORDINATOR_CALLBACK_URL:-}" ] || \
    [ -z "${GLIMMER_COORDINATOR_CALLBACK_TOKEN:-}" ] || \
    [ -z "${GLIMMER_CACHE_KEY:-}" ]; then
    BOOTSTRAP_FAILURE_CODE=configuration_invalid
    echo '{"event":"startup_failed","reason":"configuration_invalid"}' >&2
    exit 2
  fi
fi
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
if [ -n "${GLIMMER_ARTIFACT_HOSTS:-}" ]; then
  HOSTS=()
  IFS=',' read -r -a HOSTS <<< "$GLIMMER_ARTIFACT_HOSTS"
  for host in "${HOSTS[@]}"; do
    HOST_ARGS+=(--allowed-host "$host")
  done
fi

run_download() {
  local next_progress=$SECONDS
  if [ "$REQUIRE_READY_CACHE" = 1 ] && [ "$PREWARM_ONLY" = 1 ]; then
    env -u GLIMMER_COORDINATOR_CALLBACK_TOKEN \
      -u GLIMMER_WORKER_BOOTSTRAP_TOKEN \
      python3 /opt/glimmer/docker/runpod/fetch_artifact.py "$@" &
  else
    env -u GLIMMER_COORDINATOR_CALLBACK_TOKEN \
      -u GLIMMER_WORKER_BOOTSTRAP_TOKEN \
      gosu glimmer python3 /opt/glimmer/docker/runpod/fetch_artifact.py "$@" &
  fi
  DOWNLOAD_PID=$!
  while process_alive "$DOWNLOAD_PID"; do
    if [ "$PREWARM_ONLY" = 1 ] && [ "$REQUIRE_READY_CACHE" = 1 ] && \
      [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ] && \
      [ "$SECONDS" -ge "$next_progress" ]; then
      python3 "$COORDINATOR_CALLBACK_TOOL" cache-progress \
        --status "$BOOTSTRAP_STATUS_MIRROR_FILE" \
        --cache-key "$GLIMMER_CACHE_KEY" || true
      next_progress=$((SECONDS + 30))
    fi
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
  if [ "$PREWARM_ONLY" = 1 ] && [ "$REQUIRE_READY_CACHE" = 1 ] && \
    [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ]; then
    python3 "$COORDINATOR_CALLBACK_TOOL" cache-progress \
      --status "$BOOTSTRAP_STATUS_MIRROR_FILE" \
      --cache-key "$GLIMMER_CACHE_KEY" || true
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
  if [ "$USE_HASH_RECEIPTS" = true ]; then
    if run_download --url "$url" --sha256 "$sha256" --output "$output" \
      --status-file "$BOOTSTRAP_STATUS_FILE" --lease-id "$GLIMMER_LEASE_ID" \
      --status-mirror-file "$BOOTSTRAP_STATUS_MIRROR_FILE" \
      --artifact-kind "$kind" --receipt "$RECEIPT_ROOT/$kind.json" \
      "${HOST_ARGS[@]}"; then
      status=0
    else
      status=$?
    fi
  else
    if run_download --url "$url" --sha256 "$sha256" --output "$output" \
      --status-file "$BOOTSTRAP_STATUS_FILE" --lease-id "$GLIMMER_LEASE_ID" \
      --status-mirror-file "$BOOTSTRAP_STATUS_MIRROR_FILE" \
      --artifact-kind "$kind" "${HOST_ARGS[@]}"; then
      status=0
    else
      status=$?
    fi
  fi
  if [ "$status" -eq 0 ]; then
    return 0
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

CACHE_MANIFEST_ARGS=(
  --root "$MODEL_ROOT"
  --volume-id "${GLIMMER_CACHE_VOLUME_ID:-legacy}"
  --build-id "${GLIMMER_CACHE_BUILD_ID:-${GLIMMER_WORKER_BUILD_ID:-unverified}}"
  --model-sha256 "$GLIMMER_MODEL_SHA256"
  --mmproj-sha256 "$GLIMMER_MMPROJ_SHA256"
  --draft-sha256 "$GLIMMER_DFLASH_SHA256"
)

if [ "$REQUIRE_READY_CACHE" = 1 ] && [ "$PREWARM_ONLY" != 1 ]; then
  status_update --stage cache_checking
  if ! python3 "$CACHE_MANIFEST_TOOL" verify "${CACHE_MANIFEST_ARGS[@]}"; then
    BOOTSTRAP_FAILURE_CODE=cache_not_ready
    if [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ]; then
      python3 "$COORDINATOR_CALLBACK_TOOL" cache-invalid \
        --cache-key "$GLIMMER_CACHE_KEY" || true
    fi
    echo '{"event":"startup_failed","reason":"cache_not_ready"}' >&2
    exit 22
  fi
  if [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ]; then
    python3 "$COORDINATOR_CALLBACK_TOOL" heartbeat --worker-state bootstrapping || {
      BOOTSTRAP_FAILURE_CODE=coordinator_callback_failed
      exit 24
    }
  fi
else
  fetch_artifact model "$GLIMMER_MODEL_URL" "$GLIMMER_MODEL_SHA256" "$MODEL_PATH"
  fetch_artifact mmproj "$GLIMMER_MMPROJ_URL" "$GLIMMER_MMPROJ_SHA256" "$MMPROJ_PATH"
  fetch_artifact draft "$GLIMMER_DFLASH_URL" "$GLIMMER_DFLASH_SHA256" "$DFLASH_PATH"
  if [ "$REQUIRE_READY_CACHE" = 1 ]; then
    status_update --stage cache_publishing
    if [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ]; then
      python3 "$COORDINATOR_CALLBACK_TOOL" cache-progress \
        --status "$BOOTSTRAP_STATUS_MIRROR_FILE" \
        --cache-key "$GLIMMER_CACHE_KEY" || true
      CACHE_ATTESTATION="$STATE_ROOT/cache-attestation.json"
      CACHE_DOCUMENT="$STATE_ROOT/cache-document.json"
      python3 "$CACHE_MANIFEST_TOOL" prepare "${CACHE_MANIFEST_ARGS[@]}" \
        --output "$CACHE_ATTESTATION" --receipt-dir "$RECEIPT_ROOT" || {
        BOOTSTRAP_FAILURE_CODE=cache_publish_failed
        exit 23
      }
      python3 "$COORDINATOR_CALLBACK_TOOL" cache-attestation \
        --attestation "$CACHE_ATTESTATION" \
        --document-out "$CACHE_DOCUMENT" \
        --cache-key "$GLIMMER_CACHE_KEY" || {
        BOOTSTRAP_FAILURE_CODE=coordinator_callback_failed
        exit 24
      }
      python3 "$CACHE_MANIFEST_TOOL" install "${CACHE_MANIFEST_ARGS[@]}" \
        --document "$CACHE_DOCUMENT" || {
        BOOTSTRAP_FAILURE_CODE=cache_publish_failed
        exit 23
      }
      python3 "$COORDINATOR_CALLBACK_TOOL" cache-published \
        --manifest "$MODEL_ROOT/cache-ready.json" \
        --cache-key "$GLIMMER_CACHE_KEY" || {
        BOOTSTRAP_FAILURE_CODE=coordinator_callback_failed
        exit 24
      }
      rm -f "$CACHE_ATTESTATION" "$CACHE_DOCUMENT"
    elif ! GLIMMER_CACHE_SIGNING_PRIVATE_KEY="$CACHE_SIGNING_PRIVATE_KEY" \
      python3 "$CACHE_MANIFEST_TOOL" publish "${CACHE_MANIFEST_ARGS[@]}" \
        --receipt-dir "$RECEIPT_ROOT"; then
      CACHE_SIGNING_PRIVATE_KEY=""
      BOOTSTRAP_FAILURE_CODE=cache_publish_failed
      echo '{"event":"startup_failed","reason":"cache_publish_failed"}' >&2
      exit 23
    fi
    CACHE_SIGNING_PRIVATE_KEY=""
  fi
fi

if [ "$PREWARM_ONLY" = 1 ]; then
  status_update --stage ready --outcome ready
  printf 'GLIMMER_PREWARM_READY %s\n' "$GLIMMER_LEASE_ID"
  BOOTSTRAP_TERMINAL=true
  exit 0
fi

status_update --stage model_starting
env -u GLIMMER_COORDINATOR_CALLBACK_TOKEN \
  -u GLIMMER_WORKER_BOOTSTRAP_TOKEN \
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

if [ "${GLIMMER_REQUIRE_COORDINATOR_CALLBACK:-0}" = 1 ]; then
  python3 "$COORDINATOR_CALLBACK_TOOL" heartbeat --worker-state ready || {
    BOOTSTRAP_FAILURE_CODE=coordinator_callback_failed
    exit 24
  }
fi

wait "$WORKER_PID"
