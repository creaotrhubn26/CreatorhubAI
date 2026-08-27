#!/usr/bin/env bash
# Produces a pinned, checksum-verified Muse Glimmer orchestrator snapshot at
# binaries/runtime/orchestrator for Tauri to ship as a read-only resource.
#
# Local development may reuse an exact matching checkout through
# GLIMMER_ORCHESTRATOR_SOURCE. CI downloads the immutable base commit and
# applies the checked-in, checksum-pinned durability overlay. In every path,
# each final file must match its release SHA-256 before it reaches output.
set -euo pipefail

ORCHESTRATOR_REF="0ec371d9dc5f76ec68b6463585183f19ddb6180d"
RAW_BASE="https://raw.githubusercontent.com/creaotrhubn26/CreatorhubAI/${ORCHESTRATOR_REF}"
OVERLAY_ID="durable-journal-v1"
OVERLAY_PATCH_SHA256="d12e37c0cec0186d01234d04fae52f096a120ac4a346c83844ae54babcdf8c0b"
OVERLAY_MODULE_SHA256="1832b24b2aa301b3f022e4f12a199aa22f36a6eb0c166dd413b95836996ce5e6"

cd "$(dirname "$0")/.."
OUT="binaries/runtime/orchestrator"
SOURCE="${GLIMMER_ORCHESTRATOR_SOURCE:-$HOME/AI/muse-glimmer}"
OVERLAY_DIR="orchestrator-overlay"
OVERLAY_PATCH="$OVERLAY_DIR/durable-journal.patch"
OVERLAY_MODULE="$OVERLAY_DIR/glimmer_journal.py"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/glimmer-orchestrator.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

BASE_FILES=(
  "glimmer-v2.py"
  "glimmer-engineer.py"
  "glimmer_events.py"
  "glimmer_models.py"
  "glimmer-visual.py"
  "run-github-mcp.sh"
)
BASE_SHAS=(
  "3a09e47002b129063b56da89ca4602e56c5b07ee443e44a22c64a897d13b7c65"
  "f337bae58b458252e30e0cc330575aafeb3d87959b142950bc107e49bdf1bd34"
  "0e2e6978de1de562d5580e331bab1e93acfadab130de85a57bd5201d4ccad1d5"
  "bf84fe821df6ce7e21babdeecc3dab3f053519ecf1edc467b4df83434b9ff6ee"
  "0ba69bdfc9a8e50a8a2626293d3f734f2afd794a3e2f9ae7ad03d45358a967b5"
  "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33"
)
FILES=(
  "glimmer-v2.py"
  "glimmer-engineer.py"
  "glimmer_events.py"
  "glimmer_journal.py"
  "glimmer_models.py"
  "glimmer-visual.py"
  "run-github-mcp.sh"
)
SHAS=(
  "1a7e1d8b16237bcc9af4cd4a8d7d85b5b5c01ced35b3c2bd5be69156ddfd5a2d"
  "fe11fa79dae76877761de1ee2b1318099de48a94c46473919046b8b69b4ebcc8"
  "5756d4280378ba351a75605109fcb4f84231e03b8cf9dcb63722173fc865b71e"
  "1832b24b2aa301b3f022e4f12a199aa22f36a6eb0c166dd413b95836996ce5e6"
  "bf84fe821df6ce7e21babdeecc3dab3f053519ecf1edc467b4df83434b9ff6ee"
  "c9bf09838ca8742e0225a71b52ee77ac99bf4ee30f03a1b258b94828671a0ee3"
  "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33"
)

printf '%s  %s\n' "$OVERLAY_PATCH_SHA256" "$OVERLAY_PATCH" | shasum -a 256 -c -
printf '%s  %s\n' "$OVERLAY_MODULE_SHA256" "$OVERLAY_MODULE" | shasum -a 256 -c -

use_local=true
for index in "${!FILES[@]}"; do
  if [[ ! -f "$SOURCE/${FILES[$index]}" ]] || \
    ! printf '%s  %s\n' "${SHAS[$index]}" "$SOURCE/${FILES[$index]}" | \
      shasum -a 256 -c - >/dev/null 2>&1; then
    use_local=false
    break
  fi
done

if [[ "$use_local" == true ]]; then
  for file in "${FILES[@]}"; do
    cp "$SOURCE/$file" "$STAGING/$file"
  done
else
  for index in "${!BASE_FILES[@]}"; do
    file="${BASE_FILES[$index]}"
    expected="${BASE_SHAS[$index]}"
    target="$STAGING/$file"
    if [[ -f "$SOURCE/$file" ]] && \
      printf '%s  %s\n' "$expected" "$SOURCE/$file" | \
        shasum -a 256 -c - >/dev/null 2>&1; then
      cp "$SOURCE/$file" "$target"
    else
      curl --fail --location --proto '=https' --silent --show-error \
        "$RAW_BASE/$file" --output "$target"
    fi
    printf '%s  %s\n' "$expected" "$target" | shasum -a 256 -c -
  done
  patch --batch --silent -p1 -d "$STAGING" < "$OVERLAY_PATCH"
  cp "$OVERLAY_MODULE" "$STAGING/glimmer_journal.py"
fi

for index in "${!FILES[@]}"; do
  printf '%s  %s\n' "${SHAS[$index]}" "$STAGING/${FILES[$index]}" | shasum -a 256 -c -
done

test "$OUT" = "binaries/runtime/orchestrator"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$STAGING"/* "$OUT/"
chmod +x "$OUT/glimmer-v2.py" "$OUT/glimmer-engineer.py" \
  "$OUT/glimmer-visual.py" "$OUT/run-github-mcp.sh"

{
  printf '{\n  "repository": "creaotrhubn26/CreatorhubAI",\n  "commit": "%s",\n  "overlay": {"id": "%s", "patchSha256": "%s", "moduleSha256": "%s"},\n  "files": {\n' \
    "$ORCHESTRATOR_REF" "$OVERLAY_ID" "$OVERLAY_PATCH_SHA256" "$OVERLAY_MODULE_SHA256"
  for index in "${!FILES[@]}"; do
    comma=","
    [[ "$index" -eq $((${#FILES[@]} - 1)) ]] && comma=""
    printf '    "%s": "%s"%s\n' "${FILES[$index]}" "${SHAS[$index]}" "$comma"
  done
  printf '  }\n}\n'
} > "$OUT/ORIGIN.json"

printf 'orchestrator ready: src-tauri/%s (%s) at %s (checksums verified)\n' \
  "$OUT" "$(du -sh "$OUT" | cut -f1)" "$ORCHESTRATOR_REF"
