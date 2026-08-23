# Tauri desktop shell — build & operations notes

## App icon
`src-tauri/icon-source.png` (1024×1024, dark rounded square + teal glimmer
sparkle) is the single source. Regenerate every platform icon with:

```
cd src-tauri && npx @tauri-apps/cli icon icon-source.png
```

## Bundled gateway
The gateway (`server/dist` + `@glimmer/shared` + its prod npm deps) is
bundled as a Tauri `resources` entry, so a moved .app no longer needs the
repo checkout to find `dist/index.js` or `node_modules`.

```
src-tauri/scripts/prepare-gateway.sh
```

- Builds `shared` and `server` (`tsc`), then assembles
  `src-tauri/resources/gateway/` as an isolated copy: `dist/` from
  `server/dist`, `node_modules/@glimmer/shared` vendored directly from
  `shared/dist` (not installed — it isn't published to a registry), and a
  generated `package.json` (server's `dependencies` minus `@glimmer/shared`)
  installed with `npm install --omit=dev` so only the gateway's actual
  runtime deps (express, cors, transitively ~70 packages, ~4.3MB) land
  there — not the whole hoisted monorepo `node_modules`.
- Gitignored, regenerated fresh each build, same convention as
  `binaries/glimmer-node-*`.
- **Required before `cargo build`/`tauri build`** if you want the bundled
  path exercised — `tauri-build` copies `bundle.resources` into
  `target/<profile>/resources/` at *compile* time (`build.rs`), so this
  also takes effect under plain `cargo run`/`tauri dev`, not just release
  bundles. `npm run tauri:build` runs it automatically (added to that
  script alongside `prepare-sidecar.sh`).
- Runtime resolution (`src/lib.rs::gateway_dir`): `GLIMMER_GATEWAY_DIR` env
  override wins first; then the bundled resource dir
  (`app.path().resolve("resources/gateway", BaseDirectory::Resource)`) if
  `dist/index.js` exists there; then, in debug builds only, the
  compile-time repo path (`CARGO_MANIFEST_DIR/../server`) so a checkout
  that hasn't run the prepare script yet still works in dev. That last
  branch is compiled out of release builds.
- **Verified live**: with `server/dist` renamed out of the way (so the dev
  repo-path fallback would 404 if it were ever hit), running the debug
  binary spawned the gateway from
  `target/debug/resources/gateway` via the bundled `glimmer-node` sidecar
  and served real data on `GET /api/status`.

### What's still NOT bundled — external requirement, by design
`CONFIG.glimmerV2Path` / `CONFIG.engineerPath` (see `server/src/config.ts`)
default to `~/AI/muse-glimmer/glimmer-v2.py` /
`~/AI/muse-glimmer/glimmer-engineer.py` — the Python orchestrator. That
orchestrator is a separate project, is not built or shipped by this repo,
and is not part of this bundling work. `CONFIG.stateRoot` already defaults
sanely to `~/.muse-glimmer` (no change needed there). A machine without the
orchestrator checked out at that path will run the gateway and serve the
API fine, but any action that shells out to the orchestrator scripts will
fail — that's a real external dependency of the product, not a Tauri
packaging gap, and is out of scope here.

## Bundled Node sidecar
The gateway needs Node. Bundled builds ship it as a Tauri `externalBin`
sidecar so the app has zero runtime dependency on a machine-installed node.

```
src-tauri/scripts/prepare-sidecar.sh
```

- Produces `src-tauri/binaries/glimmer-node-<host-triple>` (gitignored,
  ~116MB). Named `glimmer-node` so a future linux deb/rpm never installs a
  file at `/usr/bin/node`.
- Always bundles the pinned official build (`v22.12.0`), downloaded from
  nodejs.org, **checksum-verified against SHASUMS256.txt** and cached in
  `~/.cache/glimmer-node-sidecar`. The PATH node is used only when it
  matches the pin exactly AND its copy self-tests (a homebrew node is
  `@rpath`-linked against `libnode.dylib` and dies outside its cellar).
- **Required before `cargo check`/`tauri build`** — tauri-build resolves
  `bundle.externalBin` at compile time and fails if the file is missing.
  `npm run tauri:build` runs it automatically.
- Runtime resolution (`src/lib.rs::node_binary`): the sidecar next to the
  app executable (`Contents/MacOS/glimmer-node` on macOS) wins; `node` on
  PATH is the dev-mode fallback, so `tauri dev` works without the binary.

## Notifications
WKWebView has no `window.Notification`, so the web UI feature-detects
`window.__TAURI__` (enabled via `app.withGlobalTauri`) and invokes the Rust
`notify` command (`tauri-plugin-notification`, permission
`notification:default` in `capabilities/default.json`). Browsers keep using
the Web Notification API. macOS shows its own per-app permission prompt on
first delivery — no in-app permission flow needed on the desktop path.

## Theme flash on first paint — accepted
Light-theme users may see one dark frame before `main.tsx` runs
`initTheme()`. The usual fix (an inline `<script>` in `<head>`) is blocked
by the `script-src 'self'` CSP — do NOT loosen the CSP for this; accept the
flash or use a hashed external bootstrap script if it ever matters.

## Auto-update — PARKED
`tauri-plugin-updater` needs infrastructure that does not exist yet:

1. A signing keypair (`tauri signer generate`) — public key goes in
   `tauri.conf.json` `plugins.updater.pubkey`, private key stays in CI
   secrets; every artifact must be signed at build time.
2. A reachable update endpoint serving the update JSON (version, platform
   URLs, signatures) — e.g. GitHub Releases (this repo is private, so
   release assets would need token-authenticated access, which the updater
   does not do out of the box) or a small static endpoint.
3. A release pipeline producing signed bundles per platform.

Until those exist, updates are manual (pull + `npm run tauri:build`).
Deliberately not half-shipped: an updater without signatures or a live
endpoint is worse than none.
