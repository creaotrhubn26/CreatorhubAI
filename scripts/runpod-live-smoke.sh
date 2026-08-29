#!/usr/bin/env bash
set -euo pipefail

if [ "${GLIMMER_ALLOW_PAID_RUNPOD_SMOKE:-}" != "YES" ]; then
  echo "Paid RunPod smoke is disabled. Set GLIMMER_ALLOW_PAID_RUNPOD_SMOKE=YES only in an approved live acceptance run." >&2
  exit 2
fi

echo "Live smoke requires the R3 controller/result path and is intentionally unavailable in R2." >&2
exit 3
