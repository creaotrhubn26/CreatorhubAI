#!/usr/bin/env bash
# Produces src-tauri/binaries/glimmer-node-<triple> for Tauri's externalBin
# so `tauri build` bundles a working node next to the app executable
# (Contents/MacOS/glimmer-node on macOS — named glimmer-node, not node, so a
# future linux deb/rpm never drops a file at /usr/bin/node). Gitignored
# (~50MB); required before cargo check / tauri build (tauri-build resolves
# externalBin at compile time). Dev mode runs without it (lib.rs falls back
# to PATH node).
#
# Reproducibility: the bundled node is ALWAYS the pinned official build,
# checksum-verified against nodejs.org's SHASUMS256.txt — except when the
# PATH node already matches the pinned version exactly AND its copy is
# self-contained (a homebrew node is @rpath-linked against libnode.dylib and
# dies outside its cellar; the self-test catches that).
set -euo pipefail

NODE_VERSION="v22.12.0" # pinned LTS

cd "$(dirname "$0")/.."
mkdir -p binaries

TRIPLE="$(rustc --print host-tuple 2>/dev/null || rustc -vV | sed -n 's/^host: //p')"
DEST="binaries/glimmer-node-$TRIPLE"

works() { "$1" -e "process.exit(0)" >/dev/null 2>&1; }

# 1) PATH node — only if it IS the pinned version and its copy self-tests
if command -v node >/dev/null && [ "$(node --version 2>/dev/null)" = "$NODE_VERSION" ]; then
  cp "$(command -v node)" "$DEST.tmp"
  chmod +x "$DEST.tmp"
  if works "./$DEST.tmp"; then
    mv "$DEST.tmp" "$DEST"
    echo "sidecar ready: src-tauri/$DEST ($(du -h "$DEST" | cut -f1)) from PATH node $NODE_VERSION"
    exit 0
  fi
  rm -f "$DEST.tmp"
fi

# 2) official self-contained build (cached, checksum-verified)
case "$TRIPLE" in
  aarch64-apple-darwin) DIST="darwin-arm64" ;;
  x86_64-apple-darwin)  DIST="darwin-x64" ;;
  x86_64-unknown-linux-gnu) DIST="linux-x64" ;;
  aarch64-unknown-linux-gnu) DIST="linux-arm64" ;;
  *) echo "unsupported triple $TRIPLE — fetch node manually into $DEST" >&2; exit 1 ;;
esac

CACHE="$HOME/.cache/glimmer-node-sidecar"
TARBALL="node-$NODE_VERSION-$DIST.tar.gz"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$TARBALL" ]; then
  curl -fL --proto '=https' "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$CACHE/$TARBALL.part"
  mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi
curl -fsL --proto '=https' "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"
(cd "$CACHE" && grep " $TARBALL\$" SHASUMS256.txt | shasum -a 256 -c -) \
  || { echo "checksum mismatch for $TARBALL" >&2; rm -f "$CACHE/$TARBALL"; exit 1; }
tar -xzf "$CACHE/$TARBALL" -C "$CACHE" "node-$NODE_VERSION-$DIST/bin/node"
cp "$CACHE/node-$NODE_VERSION-$DIST/bin/node" "$DEST"
chmod +x "$DEST"
works "./$DEST" || { echo "downloaded node failed self-test" >&2; exit 1; }
echo "sidecar ready: src-tauri/$DEST ($(du -h "$DEST" | cut -f1)) from nodejs.org $NODE_VERSION (checksum verified)"
