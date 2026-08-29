#!/usr/bin/env bash
# Produces a pinned, checksum-verified Muse Glimmer orchestrator snapshot at
# binaries/runtime/orchestrator for Tauri to ship as a read-only resource.
#
# Preparation requires a local checkout at the exact committed snapshot via
# GLIMMER_ORCHESTRATOR_SOURCE. It never fetches executable source from the
# network; each final file must match its release SHA-256 before output.
set -euo pipefail

ORCHESTRATOR_REF="9c183d4ee2eed102cf497fce5ae1da68afe2f14c"
SNAPSHOT_ID="glimmer-accuracy-v2"

cd "$(dirname "$0")/.."
OUT="binaries/runtime/orchestrator"
SOURCE="${GLIMMER_ORCHESTRATOR_SOURCE:-$HOME/AI/muse-glimmer}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/glimmer-orchestrator.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

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
  "run-github-mcp.sh"
)
SHAS=(
  "d937e86b031b449473df02d2137d948500fd5751dc55c9fcca5875e33bd4d44c"
  "0c1e797076d62416840512bd844964c82ebb584f2c4280ec7e5f7ec93d47bb14"
  "d31179ab2f5cedf1c7b0cf9a32452bbaa03580ed056a9163ae8ace66ea63a53e"
  "1832b24b2aa301b3f022e4f12a199aa22f36a6eb0c166dd413b95836996ce5e6"
  "584302c1b0689f70d825fe5a155ed88d410cba8c835de054429c6b233138409c"
  "84db728096ee22c016e6abdb6efdad4b88620a3a19aa6b95eda698f9fa523920"
  "cadc645a90f18cd5b069f6cd90191a55b02d9c2ad0bb16a72186baa79cce3188"
  "e1d3ce00c33f6db5d4183b1e8c237bbea50532ee051018b64b577163f864f167"
  "fbd486ad5811ab3d4872f6638dd28e996c57119324bc2f04ab20fb393c9c4711"
  "0ba69bdfc9a8e50a8a2626293d3f734f2afd794a3e2f9ae7ad03d45358a967b5"
  "409041d9bd09a9febc199f755190caab073319ba68f1f3eae5417c14c4af5c33"
)

SOURCE_COMMIT="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
if [[ "$SOURCE_COMMIT" != "$ORCHESTRATOR_REF" ]]; then
  echo "orchestrator source must be exact commit $ORCHESTRATOR_REF (got ${SOURCE_COMMIT:-unavailable})" >&2
  exit 1
fi
for index in "${!FILES[@]}"; do
  file="${FILES[$index]}"
  printf '%s  %s\n' "${SHAS[$index]}" "$SOURCE/$file" | shasum -a 256 -c -
  cp "$SOURCE/$file" "$STAGING/$file"
done

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
