#!/usr/bin/env bash
# Verifies every Mach-O file in a prepared or packaged Python runtime. Apple
# notarization requires native libraries and extension modules to carry their
# own Developer ID signature and secure timestamp; signing only the .app and
# the python3 executable is insufficient.
set -euo pipefail

ROOT="${1:-$(dirname "$0")/../binaries/runtime/python}"
ROOT="$(cd "$ROOT" && pwd)"
SIGNATURE_POLICY="${GLIMMER_SIGNATURE_POLICY:-developer-id}"
if [[ "$SIGNATURE_POLICY" != "developer-id" && "$SIGNATURE_POLICY" != "adhoc" ]]; then
  echo "unsupported signature policy: $SIGNATURE_POLICY" >&2
  exit 1
fi
NATIVE_COUNT=0

while IFS= read -r -d '' candidate; do
  if [[ "$(file -b -- "$candidate")" != Mach-O* ]]; then
    continue
  fi

  codesign --verify --strict --verbose=2 "$candidate"
  if [[ "$SIGNATURE_POLICY" == "adhoc" ]]; then
    NATIVE_COUNT=$((NATIVE_COUNT + 1))
    continue
  fi
  DETAILS="$(codesign --display --verbose=4 "$candidate" 2>&1)"
  if ! grep -Fq "Authority=Developer ID Application:" <<<"$DETAILS"; then
    echo "missing Developer ID Application signature: $candidate" >&2
    exit 1
  fi
  if ! grep -Fq "Timestamp=" <<<"$DETAILS" || grep -Fq "Timestamp=none" <<<"$DETAILS"; then
    echo "missing secure timestamp: $candidate" >&2
    exit 1
  fi

  NATIVE_COUNT=$((NATIVE_COUNT + 1))
done < <(find "$ROOT" -type f -print0)

if (( NATIVE_COUNT == 0 )); then
  echo "no Mach-O files found below $ROOT" >&2
  exit 1
fi

echo "Python native signatures valid: $NATIVE_COUNT files below $ROOT"
