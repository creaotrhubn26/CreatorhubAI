#!/usr/bin/env bash
# Produces a pinned, checksum-verified Muse Glimmer orchestrator snapshot at
# binaries/runtime/orchestrator for Tauri to ship as a read-only resource.
#
# Local development may reuse an exact matching checkout through
# GLIMMER_ORCHESTRATOR_SOURCE. The default legacy checkout is also reused
# when present. CI downloads the same immutable commit from GitHub. In every
# path, each file must match its committed SHA-256 before it reaches output.
set -euo pipefail

ORCHESTRATOR_REF="0ec371d9dc5f76ec68b6463585183f19ddb6180d"
RAW_BASE="https://raw.githubusercontent.com/creaotrhubn26/CreatorhubAI/${ORCHESTRATOR_REF}"

cd "$(dirname "$0")/.."
OUT="binaries/runtime/orchestrator"
SOURCE="${GLIMMER_ORCHESTRATOR_SOURCE:-$HOME/AI/muse-glimmer}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/glimmer-orchestrator.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

FILES=(
  "glimmer-v2.py"
  "glimmer-engineer.py"
  "glimmer_events.py"
  "glimmer_models.py"
  "glimmer-visual.py"
  "run-github-mcp.sh"
)
SHAS=(
  "3a09e47002b129063b56da89ca4602e56c5b07ee443e44a22c64a897d13b7c65"
  "f337bae58b458252e30e0cc330575aafeb3d87959b142950bc107e49bdf1bd34"
  "0e2e6978de1de562d5580e331bab1e93acfadab130de85a57bd5201d4ccad1d5"
  "bf84fe821df6ce7e21babdeecc3dab3f053519ecf1edc467b4df83434b9ff6ee"
  "0ba69bdfc9a8e50a8a2626293d3f734f2afd794a3e2f9ae7ad03d45358a967b5"
  "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33"
)

for index in "${!FILES[@]}"; do
  file="${FILES[$index]}"
  expected="${SHAS[$index]}"
  target="$STAGING/$file"

  if [[ -f "$SOURCE/$file" ]] && \
    printf '%s  %s\n' "$expected" "$SOURCE/$file" | shasum -a 256 -c - >/dev/null 2>&1; then
    cp "$SOURCE/$file" "$target"
  else
    curl --fail --location --proto '=https' --silent --show-error \
      "$RAW_BASE/$file" --output "$target"
  fi

  printf '%s  %s\n' "$expected" "$target" | shasum -a 256 -c -
done

test "$OUT" = "binaries/runtime/orchestrator"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$STAGING"/* "$OUT/"
chmod +x "$OUT/glimmer-v2.py" "$OUT/glimmer-engineer.py" \
  "$OUT/glimmer-visual.py" "$OUT/run-github-mcp.sh"

printf '{\n  "repository": "creaotrhubn26/CreatorhubAI",\n  "commit": "%s"\n}\n' \
  "$ORCHESTRATOR_REF" > "$OUT/ORIGIN.json"

printf 'orchestrator ready: src-tauri/%s (%s) at %s (checksums verified)\n' \
  "$OUT" "$(du -sh "$OUT" | cut -f1)" "$ORCHESTRATOR_REF"
