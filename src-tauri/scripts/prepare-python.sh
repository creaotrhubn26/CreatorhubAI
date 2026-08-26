#!/usr/bin/env bash
# Produces a relocatable CPython runtime for the packaged desktop app:
#
# - binaries/python3-<triple> is a Tauri externalBin, so the executable is
#   placed next to and signed like the app's glimmer-node sidecar.
# - binaries/runtime/python contains PYTHONHOME (the standard library and
#   native extension modules) and is shipped as a bundle resource.
#
# The archive is pinned and checksum-verified. No pip packages are needed:
# the Muse Glimmer orchestrator uses only Python's standard library.
set -euo pipefail

PYTHON_VERSION="3.13.15"
BUILD_DATE="20260807"

cd "$(dirname "$0")/.."
mkdir -p binaries/runtime

TRIPLE="$(rustc --print host-tuple 2>/dev/null || rustc -vV | sed -n 's/^host: //p')"
case "$TRIPLE" in
  aarch64-apple-darwin)
    SHA256="dbadb0ffe46f8bace50daaf8a0c5fc6903c003690776da9eb5269e33c856bb53"
    ;;
  x86_64-apple-darwin)
    SHA256="187eed2282e9c3a5b6b14953d564ee25a9f35cf2c209c9fa292186ee48b0e4a1"
    ;;
  *)
    echo "unsupported Python runtime target $TRIPLE (Glimmer desktop currently supports macOS)" >&2
    exit 1
    ;;
esac

TARBALL="cpython-${PYTHON_VERSION}+${BUILD_DATE}-${TRIPLE}-install_only_stripped.tar.gz"
ENCODED_TARBALL="${TARBALL/+/%2B}"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${BUILD_DATE}/${ENCODED_TARBALL}"
CACHE_ROOT="${GLIMMER_RUNTIME_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/glimmer-python-runtime}"
CACHED_ARCHIVE="$CACHE_ROOT/$TARBALL"
DEST="binaries/python3-$TRIPLE"
PYTHON_HOME="binaries/runtime/python"

mkdir -p "$CACHE_ROOT"
if [[ ! -f "$CACHED_ARCHIVE" ]]; then
  curl --fail --location --proto '=https' "$URL" --output "$CACHED_ARCHIVE.part"
  mv "$CACHED_ARCHIVE.part" "$CACHED_ARCHIVE"
fi

if ! printf '%s  %s\n' "$SHA256" "$CACHED_ARCHIVE" | shasum -a 256 -c -; then
  rm -f "$CACHED_ARCHIVE"
  echo "checksum mismatch for $TARBALL" >&2
  exit 1
fi

EXTRACT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/glimmer-python.XXXXXX")"
trap 'rm -rf "$EXTRACT_ROOT"' EXIT
tar -xzf "$CACHED_ARCHIVE" -C "$EXTRACT_ROOT"

test "$PYTHON_HOME" = "binaries/runtime/python"
rm -rf "$PYTHON_HOME"
mkdir -p "$PYTHON_HOME"
cp -R "$EXTRACT_ROOT/python/lib" "$PYTHON_HOME/lib"

# Dereference python3 -> python3.13: Tauri externalBin needs a real file with
# the target suffix, not a symlink whose target is absent from binaries/.
cp -L "$EXTRACT_ROOT/python/bin/python3" "$DEST.tmp"
chmod +x "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

PYTHONHOME="$PWD/$PYTHON_HOME" "$PWD/$DEST" -c \
  'import json, ssl, subprocess, urllib.request; print("bundled Python runtime ready")'

# Runtime repair/diagnostics cannot safely modify a signed app bundle, but it
# can prove whether its critical interpreter files still match this prepared
# snapshot. Keep the manifest inside PYTHONHOME so the gateway can find it via
# the PYTHONHOME environment it already inherits from the Tauri shell.
node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const [home, version, archive, archiveSha256] = process.argv.slice(1);
  const names = [
    "lib/python3.13/os.py",
    "lib/python3.13/ssl.py",
    "lib/python3.13/json/__init__.py",
    "lib/python3.13/sqlite3/__init__.py",
  ];
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const files = Object.fromEntries(names.map((name) => [name, hash(path.join(home, name))]));
  fs.writeFileSync(
    path.join(home, "ORIGIN.json"),
    JSON.stringify({ version, archive, archiveSha256, files }, null, 2) + "\n",
  );
' "$PYTHON_HOME" "$PYTHON_VERSION" "$TARBALL" "$SHA256"

printf 'python runtime ready: src-tauri/%s (%s) + %s (%s), CPython %s (checksum verified)\n' \
  "$DEST" "$(du -h "$DEST" | cut -f1)" \
  "$PYTHON_HOME" "$(du -sh "$PYTHON_HOME" | cut -f1)" \
  "$PYTHON_VERSION"
