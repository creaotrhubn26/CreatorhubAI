#!/usr/bin/env bash
# Produces src-tauri/resources/gateway/ — a self-contained copy of the
# Express gateway (built dist + @glimmer/shared + prod-only node_modules)
# that Tauri bundles as a `bundle.resources` entry, so a moved .app can run
# the gateway without the repo checkout present on the machine.
#
# server/dist is a plain `tsc` build (no bundler) that imports "express",
# "cors" and "@glimmer/shared" by bare specifier — those normally resolve
# via npm workspace hoisting to the monorepo root node_modules, which isn't
# shipped. So this script vendors just the runtime deps (not the hoisted
# devDeps of every other workspace) into an isolated node_modules next to
# the copied dist.
#
# Ordering matters: @glimmer/shared is copied into node_modules AFTER
# `npm install`/`npm ci` runs, never before — npm reconciles node_modules
# against package.json on every install and deletes anything not declared
# as a dependency there (@glimmer/shared is deliberately NOT declared, since
# it isn't published to a registry; it's vendored by hand). Copying it in
# first previously got silently pruned as "extraneous", crashing the
# bundled gateway with ERR_MODULE_NOT_FOUND on any machine without the repo
# checkout to fall back on.
#
# Reproducibility: express/cors + transitive deps are pinned via a
# committed lockfile (gateway-package-lock.json, next to this script) and
# installed with `npm ci` so two builds — different day, different machine
# — resolve identical versions. If server/package.json's runtime deps
# changed since the lockfile was committed, `npm ci` fails fast (it
# requires an exact match) and this script falls back to `npm install`,
# regenerating the lockfile for you to commit.
#
# Gitignored (the resources/gateway output, not the lockfile), regenerated
# fresh each build (like binaries/glimmer-node* from prepare-sidecar.sh).
# Required before `tauri build`/`cargo build` if you want the
# bundled-resource path exercised locally; without it the app still runs
# via the repo-path dev fallback (see src/lib.rs).
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root (src-tauri/scripts/../..)
OUT="src-tauri/resources/gateway"
LOCKFILE="src-tauri/scripts/gateway-package-lock.json"

echo "[prepare-gateway] building shared + server..."
npm run build -w shared
npm run build -w server

rm -rf "$OUT"
mkdir -p "$OUT"

# Isolated package.json with just the runtime deps (@glimmer/shared is
# vendored by hand below, not installed from a registry), so `npm
# install`/`npm ci` here resolves only express/cors + their transitive
# deps — not the whole hoisted monorepo node_modules.
node -e '
  const { dependencies } = require("./server/package.json");
  delete dependencies["@glimmer/shared"];
  require("fs").writeFileSync(
    process.argv[1] + "/package.json",
    JSON.stringify({ name: "glimmer-gateway", private: true, type: "module", dependencies }, null, 2)
  );
' "$OUT"

if [ -f "$LOCKFILE" ]; then
  cp "$LOCKFILE" "$OUT/package-lock.json"
fi

if [ -f "$OUT/package-lock.json" ] && (cd "$OUT" && npm ci --omit=dev --no-audit --no-fund); then
  echo "[prepare-gateway] installed pinned deps from $LOCKFILE"
else
  echo "[prepare-gateway] no matching lockfile — resolving fresh (commit $LOCKFILE afterward)"
  (cd "$OUT" && npm install --omit=dev --no-audit --no-fund)
  cp "$OUT/package-lock.json" "$LOCKFILE"
fi

# Vendor @glimmer/shared AFTER install/ci — see ordering note above.
mkdir -p "$OUT/node_modules/@glimmer/shared"
cp -R shared/dist "$OUT/node_modules/@glimmer/shared/dist"
cp shared/package.json "$OUT/node_modules/@glimmer/shared/package.json"

cp -R server/dist/. "$OUT/dist/"

echo "gateway bundle ready: $OUT ($(du -sh "$OUT" | cut -f1))"
