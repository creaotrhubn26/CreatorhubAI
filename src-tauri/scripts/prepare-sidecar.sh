#!/usr/bin/env bash
# Produces src-tauri/binaries/node-<triple> for Tauri's externalBin so
# `tauri build` bundles a working node next to the app executable
# (Contents/MacOS/node on macOS). Gitignored (~50MB); run before any
# bundling build. Dev mode works without it (lib.rs falls back to PATH).
#
# The PATH node is tried first but VERIFIED by executing the copy — a
# homebrew node is @rpath-linked against libnode.dylib and dies outside its
# cellar, so a broken copy falls through to downloading the official
# self-contained build from nodejs.org (pinned, cached in ~/.cache).
set -euo pipefail

NODE_VERSION="v22.12.0" # pinned LTS for reproducible bundles

cd "$(dirname "$0")/.."
mkdir -p binaries

TRIPLE="$(rustc --print host-tuple 2>/dev/null || rustc -vV | sed -n 's/^host: //p')"
DEST="binaries/node-$TRIPLE"

works() { "$1" -e "process.exit(0)" >/dev/null 2>&1; }

# 1) PATH node, if its copy is self-contained
if command -v node >/dev/null; then
  cp "$(command -v node)" "$DEST.tmp"
  chmod +x "$DEST.tmp"
  if works "./$DEST.tmp"; then
    mv "$DEST.tmp" "$DEST"
    echo "sidecar ready: src-tauri/$DEST ($(du -h "$DEST" | cut -f1)) from PATH node"
    exit 0
  fi
  rm -f "$DEST.tmp"
  echo "PATH node is not self-contained (dynamic libnode) — fetching official build"
fi

# 2) official self-contained build (cached)
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
tar -xzf "$CACHE/$TARBALL" -C "$CACHE" "node-$NODE_VERSION-$DIST/bin/node"
cp "$CACHE/node-$NODE_VERSION-$DIST/bin/node" "$DEST"
chmod +x "$DEST"
works "./$DEST" || { echo "downloaded node failed self-test" >&2; exit 1; }
echo "sidecar ready: src-tauri/$DEST ($(du -h "$DEST" | cut -f1)) from nodejs.org $NODE_VERSION"
