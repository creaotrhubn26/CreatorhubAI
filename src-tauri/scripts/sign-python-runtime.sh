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
SIGNATURE_POLICY="developer-id"
if [[ "$IDENTITY" == "-" ]]; then
  if [[ "${GLIMMER_ALLOW_ADHOC_SIGNING:-0}" != "1" ]]; then
    echo "ad-hoc signing requires GLIMMER_ALLOW_ADHOC_SIGNING=1" >&2
    exit 1
  fi
  SIGNATURE_POLICY="adhoc"
fi
ROOT="$(cd "$(dirname "$0")/../binaries/runtime/python" && pwd)"
NATIVE_COUNT=0

while IFS= read -r -d '' candidate; do
  if [[ "$(file -b -- "$candidate")" != Mach-O* ]]; then
    continue
  fi

  if [[ "$SIGNATURE_POLICY" == "developer-id" ]]; then
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$candidate"
  else
    codesign --force --sign - "$candidate"
  fi
  NATIVE_COUNT=$((NATIVE_COUNT + 1))
done < <(find "$ROOT" -type f -print0)

if (( NATIVE_COUNT == 0 )); then
  echo "no Mach-O files found below $ROOT" >&2
  exit 1
fi

# Signing rewrites Mach-O load commands and therefore changes the byte-level
# digests recorded during preparation. Refresh only the deterministic native
# module entries after all signatures are final; the outer signed app bundle
# protects this manifest in production.
node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const originPath = path.join(root, "ORIGIN.json");
  const origin = JSON.parse(fs.readFileSync(originPath, "utf8"));
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const nativeFiles = {};
  const sitePackages = path.join(root, "lib/python3.13/site-packages");
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /\.(so|dylib)$/.test(entry.name)) {
        nativeFiles[path.relative(root, target)] = hash(target);
      }
    }
  };
  visit(sitePackages);
  origin.treeSitterNativeFiles = nativeFiles;
  fs.writeFileSync(originPath, JSON.stringify(origin, null, 2) + "\n");
' "$ROOT"

GLIMMER_SIGNATURE_POLICY="$SIGNATURE_POLICY" \
  "$(dirname "$0")/verify-python-signatures.sh" "$ROOT"
echo "Python native runtime signed: $NATIVE_COUNT files with $IDENTITY"
