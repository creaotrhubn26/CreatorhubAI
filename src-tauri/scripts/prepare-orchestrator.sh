#!/usr/bin/env bash
# Produces a pinned, checksum-verified Muse Glimmer orchestrator snapshot at
# binaries/runtime/orchestrator for Tauri to ship as a read-only resource.
#
# Preparation requires a local checkout at the exact committed snapshot via
# GLIMMER_ORCHESTRATOR_SOURCE. It never fetches executable source from the
# network; each final file must match its release SHA-256 before output.
set -euo pipefail

ORCHESTRATOR_REF="1a84a9a1171cf2a37437e84a6a1a3dd019b13e1f"
SNAPSHOT_ID="glimmer-runpod-r5"
RUNPOD_WORKFLOW_SHA="c2f1b367b894a7dfea31c84ca844c52fd254b84e8b6aaaa0cfb2ff0d2b79c952"

cd "$(dirname "$0")/.."
OUT="binaries/runtime/orchestrator"
SOURCE="${GLIMMER_ORCHESTRATOR_SOURCE:-$HOME/AI/muse-glimmer}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/glimmer-orchestrator.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

if [[ -d "$SOURCE" ]]; then
  SOURCE_COMMIT="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
else
  SOURCE="$STAGING/source"
  SOURCE_COMMIT="$(git -C .. rev-parse "${ORCHESTRATOR_REF}^{commit}" 2>/dev/null || true)"
  if [[ "$SOURCE_COMMIT" != "$ORCHESTRATOR_REF" ]]; then
    echo "orchestrator commit $ORCHESTRATOR_REF is unavailable; CI checkouts require fetch-depth: 0" >&2
    exit 1
  fi
  mkdir -p "$SOURCE"
  git -C .. archive "$ORCHESTRATOR_REF" | tar -x -C "$SOURCE"
fi

FILES=(
  "glimmer-v2.py"
  "glimmer-engineer.py"
  "glimmer_events.py"
  "glimmer_journal.py"
  "glimmer_models.py"
  "glimmer_memory.py"
  "glimmer_quality.py"
  "glimmer_semantic.py"
  "glimmer_verification.py"
  "glimmer-visual.py"
  "glimmer_remote.py"
  "runpod_worker.py"
  "run-github-mcp.sh"
  "eval-baselines/baseline-stub.json"
  "eval-baselines/latest-stub.json"
  "eval-baselines/baseline-live.json"
  "eval-baselines/latest-live.json"
)
SHAS=(
  "23f4195a04db230d378bcdfcaa407af59c8b6269ec2fe813dc527283e23e2b0a"
  "1d94fbfc892918d378d57ac4c5b2f258641251499a14ff485664ebde6565096f"
  "7bbf8ace8c591704a152297c2978520a8ec59dd1e3c19b75ddd54a2453fc42e4"
  "67a28a2c480ca65ff49133968bda89a0c4f9e670aa02e28cd5fcb3e269464cf5"
  "584302c1b0689f70d825fe5a155ed88d410cba8c835de054429c6b233138409c"
  "84db728096ee22c016e6abdb6efdad4b88620a3a19aa6b95eda698f9fa523920"
  "cadc645a90f18cd5b069f6cd90191a55b02d9c2ad0bb16a72186baa79cce3188"
  "998bcc8b0cf49a5e729c842a0be08344ec397ff8d216f92a61c3fb22bf7d02cb"
  "fbd486ad5811ab3d4872f6638dd28e996c57119324bc2f04ab20fb393c9c4711"
  "e67d2448adbdb34f00a523acee93de8fc25bbde8c26fbe4120f88f60ad19f1d6"
  "b2f7e2dab8478d95dd09787dc0cd3cbacd3a6f7e482a865f9f179f4c2089083d"
  "1e004bb6dfcaf26a4d92468015b4770f00754ee1ae62e6b079d7834ff97390a8"
  "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33"
  "65fcc635efca36848fa1e1b4069a99ee8c8f556760ef50ada005f52564976c18"
  "ab485efbfca4f7eb10d6105ad3b82c9b2cb82afba9231c9d4da915475c734a45"
  "342ea08539e3dafb23bd0a529a63fd5b398f721412261fc8e4a6c5cecfb3aa41"
  "67b2c16d33f3cb59131d3a14147fa3912b3467bc28cb06736cda327ba7116d91"
)

if [[ "$SOURCE_COMMIT" != "$ORCHESTRATOR_REF" ]]; then
  echo "orchestrator source must be exact commit $ORCHESTRATOR_REF (got ${SOURCE_COMMIT:-unavailable})" >&2
  exit 1
fi
printf '%s  %s\n' "$RUNPOD_WORKFLOW_SHA" "$SOURCE/.github/workflows/runpod-image.yml" | shasum -a 256 -c -
printf '%s  %s\n' "$RUNPOD_WORKFLOW_SHA" "../.github/workflows/runpod-image.yml" | shasum -a 256 -c -
for index in "${!FILES[@]}"; do
  file="${FILES[$index]}"
  printf '%s  %s\n' "${SHAS[$index]}" "$SOURCE/$file" | shasum -a 256 -c -
  mkdir -p "$STAGING/$(dirname "$file")"
  cp "$SOURCE/$file" "$STAGING/$file"
done

for index in "${!FILES[@]}"; do
  printf '%s  %s\n' "${SHAS[$index]}" "$STAGING/${FILES[$index]}" | shasum -a 256 -c -
done


# Pin-drift guard: the gateway's own integrity table
# (server/src/lib/diagnostics.ts BUNDLED_ORCHESTRATOR_SHA256) must agree
# with the pins above — a third copy of these hashes once drifted silently
# and the shipped app refused its own orchestrator. Fail the build loudly
# instead.
DIAGNOSTICS_TS="server/../server/src/lib/diagnostics.ts"
DIAGNOSTICS_TS="$(cd .. && pwd)/server/src/lib/diagnostics.ts"
for index in "${!FILES[@]}"; do
  file="${FILES[$index]}"
  case "$file" in eval-baselines/*) continue;; esac
  if ! grep -q "\"${SHAS[$index]}\"" "$DIAGNOSTICS_TS"; then
    echo "pin drift: diagnostics.ts BUNDLED_ORCHESTRATOR_SHA256 disagrees for $file" >&2
    exit 1
  fi
done

# Pin-drift guard, part 2: the release/CI runtime verifier
# (scripts/verify-bundled-runtime.mjs) hardcodes the expected orchestrator
# commit and snapshot. A fourth pin site that once shipped stale and failed
# the release build after the snapshot was rolled — fail the prepare step
# loudly instead of the release.
VERIFY_MJS="$(cd .. && pwd)/scripts/verify-bundled-runtime.mjs"
if ! grep -q "\"${ORCHESTRATOR_REF}\"" "$VERIFY_MJS"; then
  echo "pin drift: verify-bundled-runtime.mjs EXPECTED_ORCHESTRATOR_COMMIT is not ${ORCHESTRATOR_REF}" >&2
  exit 1
fi
if ! grep -q "\"${SNAPSHOT_ID}\"" "$VERIFY_MJS"; then
  echo "pin drift: verify-bundled-runtime.mjs EXPECTED_ORCHESTRATOR_SNAPSHOT is not ${SNAPSHOT_ID}" >&2
  exit 1
fi
# ...and its per-file EXPECTED_ORCHESTRATOR_FILES table (every file, including
# eval-baselines and run-github-mcp.sh, unlike the gateway's table above).
for index in "${!FILES[@]}"; do
  if ! grep -q "\"${SHAS[$index]}\"" "$VERIFY_MJS"; then
    echo "pin drift: verify-bundled-runtime.mjs EXPECTED_ORCHESTRATOR_FILES disagrees for ${FILES[$index]}" >&2
    exit 1
  fi
done

test "$OUT" = "binaries/runtime/orchestrator"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$STAGING"/. "$OUT/"
chmod +x "$OUT/glimmer-v2.py" "$OUT/glimmer-engineer.py" \
  "$OUT/glimmer-visual.py" "$OUT/glimmer_remote.py" \
  "$OUT/runpod_worker.py" "$OUT/run-github-mcp.sh"

{
  printf '{\n  "repository": "creaotrhubn26/CreatorhubAI",\n  "commit": "%s",\n  "snapshot": {"id": "%s"},\n  "files": {\n' \
    "$ORCHESTRATOR_REF" "$SNAPSHOT_ID"
  for index in "${!FILES[@]}"; do
    comma=","
    [[ "$index" -eq $((${#FILES[@]} - 1)) ]] && comma=""
    printf '    "%s": "%s"%s\n' "${FILES[$index]}" "${SHAS[$index]}" "$comma"
  done
  printf '  }\n}\n'
} > "$OUT/ORIGIN.json"

printf 'orchestrator ready: src-tauri/%s (%s) at %s (checksums verified)\n' \
  "$OUT" "$(du -sh "$OUT" | cut -f1)" "$ORCHESTRATOR_REF"
