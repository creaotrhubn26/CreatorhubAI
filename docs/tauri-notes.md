# Tauri desktop shell — build & operations notes

## App icon
`src-tauri/icon-source.png` (1024×1024, dark rounded square + teal glimmer
sparkle) is the single source. Regenerate every platform icon with:

```
cd src-tauri && npx @tauri-apps/cli icon icon-source.png
```

## Bundled Node sidecar
The gateway needs Node. Bundled builds ship it as a Tauri `externalBin`
sidecar so the app has zero runtime dependency on a machine-installed node.
**The bundle is still not fully self-contained**: `gateway_dir()` falls back
to the compile-time repo path (`CARGO_MANIFEST_DIR/../server`), so a moved
.app on a machine without the repo checkout + built `server/dist` shows
"Unavailable" — bundling the gateway itself is the remaining follow-up.

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
