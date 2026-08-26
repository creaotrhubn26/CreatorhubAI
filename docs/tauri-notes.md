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

- Builds `shared` and `server` (`tsc` — `server/tsconfig.json` excludes
  `src/**/*.test.ts`, mirroring `shared/tsconfig.json`, so no compiled test
  files land in `dist/` or the shipped bundle), then assembles
  `src-tauri/resources/gateway/` as an isolated copy: a generated
  `package.json` (server's `dependencies` minus `@glimmer/shared`)
  installed with `npm ci --omit=dev` against a **committed** lockfile
  (`src-tauri/scripts/gateway-package-lock.json`) so the ~70 transitive
  packages (express, cors, ~4.2MB) resolve identically across machines and
  time; falls back to `npm install` (and re-commits the lockfile) if the
  lockfile no longer matches the generated `package.json` — e.g. after a
  server dependency bump. `node_modules/@glimmer/shared` is then vendored
  by hand from `shared/dist` (it isn't published to a registry, so it's
  never a declared dependency) **after** the install/`ci` step, never
  before — npm prunes anything not declared in `package.json` on every
  install, so copying it in first got it silently deleted as "extraneous",
  which crashed the gateway with `ERR_MODULE_NOT_FOUND` on any machine
  without the repo checkout to invisibly fall back on (caught in review:
  both live tests in the original version of this work ran the bundled
  gateway from _inside_ the git checkout, where it silently succeeded via
  the workspace's hoisted `node_modules/@glimmer/shared` symlink instead of
  the vendored copy — the exact failure mode this bundling exists to
  prevent).
- `resources/gateway/` itself is gitignored, regenerated fresh each build
  (like `binaries/glimmer-node-*`); the lockfile next to the script is
  committed.
- **Required before `cargo build`/`tauri build`** if you want the bundled
  path exercised — `tauri-build` copies `bundle.resources` into
  `target/<profile>/resources/` at _compile_ time (`build.rs`), so this
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
- **Verified live, off-repo**: copied the built `resources/gateway/` to
  `/tmp` (no ancestor `node_modules` reachable at all — the actual failure
  mode the earlier in-repo test masked) and ran it there with the bundled
  `glimmer-node` sidecar binary directly: served real data on
  `GET /api/status` with no `ERR_MODULE_NOT_FOUND`. Also re-ran the
  original in-repo checks (debug binary with `server/dist` renamed away,
  and the actual built `.app`/`.dmg` via `npm run tauri:build`, quit via
  the app's Quit menu) — all still pass.
- **Stale-vendor caveat**: `prepare-gateway.sh` is only re-run by the
  blessed `tauri:build` entry point. Editing `server/src` and running
  `cargo build`/`cargo check` directly (without re-running the script)
  ships a stale `dist/` — there's no mtime/hash guard against this, just
  this documented invariant.

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

## PATH for the gateway child

A GUI-launched .app inherits launchd's minimal PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`) — no node, no npm. That PATH reached the
gateway, then glimmer-v2.py, then its verification commands, so every real
task in the packaged app failed with `npm: command not found` →
INFRA_BLOCKED. `src/lib.rs::resolve_user_path` fixes it at the source:

- Ask the login shell once at startup: `$SHELL -ilc 'printf
__GLIMMER_PATH__%s\n "$PATH"'`, 5s timeout (killed on timeout). `-i` so
  interactive-only rc files are sourced; the marker prefix means an rc-file
  banner can never be mistaken for the PATH.
- Fall back to `/opt/homebrew/bin:/usr/local/bin:/usr/bin` prepended to the
  inherited PATH if the shell can't be asked, times out, or returns a PATH
  with no node in it.
- The result is passed explicitly as the gateway child's `PATH` env (and
  used to locate `node` when no sidecar is bundled — `execvp` searches the
  _parent's_ PATH, which is the launchd one). Every outcome is logged,
  including "no node found anywhere", which is never silently swallowed.
- The gateway logs its own inherited PATH at boot (`[gateway] PATH=...`),
  so a packaged run can be checked from the app's stdout or `ps eww <pid>`.

## CLI and integration checks

Settings → **CLI & Integrations** reports the tools visible on that resolved
PATH. `GET /api/integrations/cli` performs fixed-argument, no-shell probes for
Git, GitHub CLI, Python, npm, Cargo, pnpm, Yarn and Homebrew, and separately
checks the bundled Node runtime and configured orchestrator files.

- Detection never installs a package, starts an authentication flow or returns
  command output that may contain credentials. GitHub authentication is reduced
  to `ready` / `authentication_required`; an invalid token is never included in
  the response.
- Missing tools get a visible, copyable manual command when there is a safe
  macOS suggestion. Authentication likewise remains a Terminal action. The app
  does not silently mutate the user's machine during install or first launch.
- The agent can use GitHub CLI only through a positive read-only allowlist:
  `gh auth status` and selected `repo`, `pr`, `issue`, `run`, `workflow` and
  `release` list/view/status/checks/diff operations. `gh api`, token/auth
  changes, repository overrides, create/edit/comment/merge actions, workflow
  triggers, release changes, `--web` and `--watch` are blocked before dispatch.
- Git push and deployment remain blocked. npm dependency changes keep the
  existing explicit approval boundary; validation-only Python/Cargo/npm actions
  keep their existing allowlists. Detected pnpm, Yarn and Homebrew binaries are
  informational and are not agent-executable.

## Who may call the gateway

`server/src/app.ts::localOnlyGuard` runs ahead of every router:

- **Host** must be a loopback spelling (`127.0.0.1`, `localhost`, `[::1]`,
  any port — never pin one, supertest binds ephemeral ports). This is what
  stops DNS rebinding making an attacker page same-origin with the API.
- **State-changing methods** (POST/PUT/PATCH/DELETE) must carry an `Origin`
  from the allowlist: the dev web server (`:5183`, both spellings) and
  `tauri://localhost` — captured from the installed bundle, not assumed.
  A **missing** Origin is rejected too: browsers always send one on
  cross-origin writes (including `text/plain` form posts, which is the
  attack shape), so allowing Origin-less writes would only be a
  header-omission bypass. A CLI client must therefore send
  `-H "Origin: http://127.0.0.1:5183"`.
- CORS is unchanged and still governs what may be _read_; it never stopped a
  cross-origin request from _executing_, which is why the guard exists.

## Model server lifecycle

Start/Stop from the Model screen run only `start-glimmer.sh` /
`stop-glimmer.sh` (absolute paths from CONFIG, argv, no shell). Two things
worth knowing:

- llama-server is spawned **detached** and keeps running after you quit the
  app — a 1–2 minute model load is worth more than tidiness, but that also
  means ~20 GB stays resident until someone presses Stop. The Model screen
  says so in the ONLINE/LOADING notes.
- Stop is port-keyed (the script uses `lsof` on the model port), so it also
  stops a llama-server started by hand in a terminal. The gateway
  additionally SIGTERMs the process group of a process it started itself,
  because a process that hasn't bound yet is invisible to the script — and
  it reports `stopped: false` with a reason when the target survives.

## Code signing & notarization (macOS)

Release bundles are required to be Developer ID signed, hardened-runtime,
notarized and stapled so they open with no Gatekeeper prompt. **No credential
lives in this repo.** The tag workflow fails before building if any required
secret is missing; it never silently publishes an ad-hoc-signed app.

| GitHub secret                | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded Developer ID Application `.p12` certificate                             |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when the `.p12` was exported                                             |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: Creatorhub AS (9TAUZCPK95)`                                 |
| `APPLE_API_KEY`              | App Store Connect API key ID                                                           |
| `APPLE_API_ISSUER`           | App Store Connect API issuer ID                                                        |
| `APPLE_API_KEY_CONTENT`      | Contents of the matching private `.p8` key; materialized only on the temporary CI host |

CreatorHub's Developer ID Application identity is present in the local login
Keychain and is valid until June 2031. The release workflow imports an exported
copy of that identity, signs the app and sidecar inside-out, notarizes through
CreatorHub's existing App Store Connect Admin API key, staples the ticket, and
creates a **draft** release. It does not depend on a personal Apple ID password.
Config side (committed, no secrets):
`bundle.macOS.hardenedRuntime: true` and
`bundle.macOS.entitlements: "entitlements.plist"`.

`entitlements.plist` carries exactly one entitlement,
`com.apple.security.cs.allow-jit`, and that minimum is measured, not
guessed: under hardened runtime the bundled node dies immediately
(exit 133) without it and runs fine with it alone —
`allow-unsigned-executable-memory` and `disable-library-validation` are not
needed (V8 uses proper MAP_JIT pages; nothing here dlopens unsigned code).

Verify a build:

```
codesign --verify --deep --strict --verbose=2 "Glimmer Control Center.app"
spctl -a -vvv -t install "Glimmer Control Center.app"   # must say: source=Notarized Developer ID
xcrun stapler validate "Glimmer Control Center.app"
```

If notarization is rejected, read the real reason with `xcrun notarytool
log <submission-id>` — never "fix" it by turning off hardened runtime.

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

## Signed auto-update

The update path is implemented for the macOS Apple Silicon desktop app:

- `tauri-plugin-updater` verifies every downloaded artifact against the
  public key embedded in `tauri.conf.json`. Signature verification is
  mandatory in Tauri and is not bypassed by Glimmer.
- The private updater key is outside the repository at
  `~/.tauri/glimmer-control-center` (mode `0600`). Its password is in the
  macOS Keychain under service
  `no.creatorhubn.glimmer-control-center.updater`; both values also exist as
  write-only GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The encrypted private key is also
  backed up in Keychain service
  `no.creatorhubn.glimmer-control-center.updater.private-key`. Treat it as a
  release-critical recovery asset and include the login Keychain in the
  machine's encrypted backup.
- This repository is public. Published release assets are therefore reachable
  at the static endpoint embedded in the app:
  `https://github.com/creaotrhubn26/CreatorhubAI/releases/latest/download/latest.json`.
- Normal local builds do not create updater artifacts and need no updater
  private key. `tauri.release.conf.json` enables
  `bundle.createUpdaterArtifacts` only in the release workflow.
- Settings → **App updates** performs no background request. Checking,
  downloading/installing, and restarting are three explicit user actions.
  Browsers show an honest unsupported state.

### Release procedure

1. Choose a new SemVer version and update both `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`. Run `npm run release:check` and the full quality
   suite.
2. Commit and push the version change. Create and push the matching tag, for
   example `v0.2.0`. The workflow rejects a tag that does not match both files.
3. `.github/workflows/release.yml` builds only macOS Apple Silicon, checks all
   updater/Apple secrets, runs quality gates, signs, notarizes, staples, and
   uploads the `.dmg`, updater archive, signature and `latest.json` to a GitHub
   **draft** release.
4. Download the draft artifact and run the verification commands above. Also
   inspect `latest.json` and confirm its `darwin-aarch64` URL and signature
   refer to the attached archive. Run
   `npm run release:verify -- "path/to/Glimmer Control Center.app.tar.gz"`
   to cryptographically verify the archive against the public key embedded in
   Glimmer.
5. Publish the draft manually. A draft is never returned by `/releases/latest`,
   so existing installations cannot see it before this approval.

Do not publish an updater release unless the workflow preflight and post-build
signature, stapling, Gatekeeper, and updater-signature checks all pass. A local
Developer ID identity alone is not enough; all Apple and updater secrets listed
above must also exist in the Glimmer GitHub repository.

### Rollback

Tauri correctly rejects older SemVer releases by default. Do not enable
`allowDowngrades`, replace the embedded public key, delete signatures, or edit
`latest.json` by hand.

For a bad published release, check out the last known-good commit, apply any
necessary compatibility fix, assign a **new higher patch version**, and run the
same release procedure. Publish that replacement after verification. Keep the
bad release and its evidence available until the replacement is live; then mark
it clearly in GitHub rather than silently rewriting artifacts under an existing
version.
