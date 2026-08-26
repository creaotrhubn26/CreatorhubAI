#!/usr/bin/env bash
# Developer ID-signs native libraries in the prepared Python resource before
# Tauri copies it into the .app. Tauri signs externalBin executables and the
# app itself, but native files nested in generic Resources need this explicit
# pass to satisfy Apple notarization.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Python runtime signing is only supported on macOS" >&2
  exit 1
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}"
ROOT="$(cd "$(dirname "$0")/../binaries/runtime/python" && pwd)"
NATIVE_COUNT=0

while IFS= read -r -d '' candidate; do
  if [[ "$(file -b -- "$candidate")" != Mach-O* ]]; then
    continue
  fi

  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$candidate"
  NATIVE_COUNT=$((NATIVE_COUNT + 1))
done < <(find "$ROOT" -type f -print0)

if (( NATIVE_COUNT == 0 )); then
  echo "no Mach-O files found below $ROOT" >&2
  exit 1
fi

"$(dirname "$0")/verify-python-signatures.sh" "$ROOT"
echo "Python native runtime signed: $NATIVE_COUNT files with $IDENTITY"
