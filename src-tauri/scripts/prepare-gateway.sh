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
# Gitignored, regenerated fresh each build (like binaries/glimmer-node* from
# prepare-sidecar.sh). Required before `tauri build`/`cargo build` if you
# want the bundled-resource path to be exercised locally; without it the app
# still runs via the repo-path dev fallback (see src/lib.rs).
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root (src-tauri/scripts/../..)
OUT="src-tauri/resources/gateway"

echo "[prepare-gateway] building shared + server..."
npm run build -w shared
npm run build -w server

rm -rf "$OUT"
mkdir -p "$OUT/dist" "$OUT/node_modules/@glimmer/shared"

cp -R server/dist/. "$OUT/dist/"
cp -R shared/dist "$OUT/node_modules/@glimmer/shared/dist"
cp shared/package.json "$OUT/node_modules/@glimmer/shared/package.json"

# Isolated package.json with just the runtime deps (@glimmer/shared is
# vendored above, not installed from a registry), so `npm install` here
# resolves only express/cors + their transitive deps — not the whole
# hoisted monorepo node_modules.
node -e '
  const { dependencies } = require("./server/package.json");
  delete dependencies["@glimmer/shared"];
  require("fs").writeFileSync(
    process.argv[1] + "/package.json",
    JSON.stringify({ name: "glimmer-gateway", private: true, type: "module", dependencies }, null, 2)
  );
' "$OUT"

(cd "$OUT" && npm install --omit=dev --no-audit --no-fund --no-package-lock)

echo "gateway bundle ready: $OUT ($(du -sh "$OUT" | cut -f1))"
