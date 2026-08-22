# Tauri desktop shell — build & operations notes

## App icon
`src-tauri/icon-source.png` (1024×1024, dark rounded square + teal glimmer
sparkle) is the single source. Regenerate every platform icon with:

```
cd src-tauri && npx @tauri-apps/cli icon icon-source.png
```

## Bundled Node sidecar
The gateway needs Node. Bundled builds ship it as a Tauri `externalBin`
sidecar so the app has zero runtime dependency on a machine-installed node:

```
src-tauri/scripts/prepare-sidecar.sh
```

- Produces `src-tauri/binaries/node-<host-triple>` (gitignored, ~116MB).
- Tries the PATH node first but **verifies the copy actually runs** — a
  homebrew node is `@rpath`-linked against `libnode.dylib` and dies outside
  its cellar, so a broken copy falls through to downloading the official
  self-contained build from nodejs.org (pinned `v22.12.0`, cached in
  `~/.cache/glimmer-node-sidecar`).
- **Required before `cargo check`/`tauri build`** — tauri-build resolves
  `bundle.externalBin` at compile time and fails if the file is missing.
- Runtime resolution (`src/lib.rs::node_binary`): the sidecar next to the
  app executable (`Contents/MacOS/node` on macOS) wins; `node` on PATH is
  the dev-mode fallback, so `tauri dev` works without the binary present.

## Notifications
WKWebView has no `window.Notification`, so the web UI feature-detects
`window.__TAURI__` (enabled via `app.withGlobalTauri`) and invokes the Rust
`notify` command (`tauri-plugin-notification`, permission
`notification:default` in `capabilities/default.json`). Browsers keep using
the Web Notification API. macOS shows its own per-app permission prompt on
first delivery — no in-app permission flow needed on the desktop path.

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
