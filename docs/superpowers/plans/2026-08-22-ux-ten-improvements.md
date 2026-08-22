# UX Ten Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the 10 prioritized UX improvements from the dogfood review: running-session liveness, failure visibility, completion notification, command palette + shortcuts, diff syntax highlighting, clickable status bar, empty-state actions, assistant persistence + streaming, light theme, Tauri maturity.

**Architecture:** Three rounds, each its own branch → PR → merge on control-center repo (`~/AI/muse-glimmer/control-center`, branch `main`). Round A = running UX (tasks 1-3, branch `ux-round-a-running`), Round B = IDE interaction (tasks 4-6, branch `ux-round-b-ide`), Round C = polish + Tauri (tasks 7-10, branch `ux-round-c-polish`). All web work extends the existing design system in `web/src/theme.css` and IDE shell in `web/src/components/layout/AppShell.tsx`.

**Tech Stack:** React 18 + TS + vite + vitest (jsdom), Express gateway (server/), Tauri 2 (src-tauri/). NO new npm dependencies anywhere — hand-roll or skip.

**Spec:** The 10-item list agreed with the user (reproduced per task below). Binding honesty rules: never fabricate state; model output vs deterministic fact must stay provenance-labeled; existing copy strings are preserved byte-identical unless a task explicitly changes them.

## Global Constraints

- No new npm dependencies. No new Rust crates unless Task 10 explicitly says so.
- All existing tests keep passing: run `npm run build && npm run test` from repo root (workspaces). 340+ tests green before commit.
- Dark theme remains the default; nothing may visually regress it.
- Never touch commit/push/deploy permission logic or the `--auto-approve` line in `server/src/lib/runner.ts`.
- Copy/strings: UI copy is English, matches existing tone (terse, lowercase-ish labels like existing).
- Each task commits on its round's branch with a conventional message (`feat:`/`fix:`).

---

### Task 1: Running-session liveness (elapsed time + last-activity + pulsing indicator)

**Files:**
- Modify: `web/src/components/layout/AppShell.tsx` (SessionEventsContext lives here; session tree + tabs + status bar)
- Modify: `web/src/components/session/ActiveSessionScreen.tsx` (header area)
- Modify: `web/src/theme.css` (pulse animation + classes)
- Test: `web/src/components/session/liveness.test.tsx` (new)

**Requirements:**
- Extract a small pure helper module `web/src/state/liveness.ts`:
  - `formatElapsed(startIso: string, nowMs: number): string` → `"4m 12s"` style.
  - `lastActivityLabel(lastEventAtMs: number | null, nowMs: number): string | null` → `null` if no events yet, else `"last activity 12s ago"` (`"just now"` under 5s, minutes form `"3m ago"` above 60s).
  - `isStalled(lastEventAtMs: number | null, nowMs: number): boolean` → true when a running session has had no event for ≥120s.
- SessionEventsContext already receives every SSE event: record `lastEventAt` (Date.now() at receipt) in that context so any consumer can read it.
- For a session whose status is running/active: show in the ActiveSessionScreen header a live line: elapsed time since session start + last-activity label, ticking via a 1s `setInterval` (single interval, cleared on unmount). When `isStalled` → the last-activity label renders in `--amber` with text suffix `" — possibly stalled"`.
- Session tree item + tab for a running session get a pulsing dot (CSS `@keyframes` opacity pulse on the existing status dot class; `animation` only applied when running). No pulse for terminal states.
- Honesty: elapsed/last-activity derive ONLY from deterministic data (session startedAt, SSE receipt times). If startedAt is missing, omit elapsed rather than guessing.

**Interfaces:**
- Produces: `liveness.ts` exports above; `SessionEventsContext` gains `lastEventAt: number | null`.

**Steps:** write failing tests for the three helpers (fake timers), implement helpers, wire context + UI, run web tests, full build+test, commit `feat: running-session liveness (elapsed, last activity, pulse)`.

### Task 2: Failure banner

**Files:**
- Modify: `web/src/components/session/ActiveSessionScreen.tsx`
- Modify: `web/src/theme.css`
- Test: extend an existing ActiveSessionScreen test file or add `failureBanner.test.tsx`

**Requirements:**
- `GlimmerSession` already carries optional `failure` (`{ class, detail? }` — check `shared/src/types.ts` for exact shape; taxonomy values like INFRA_BLOCKED, TIMEOUT, CODE_FAIL, POLICY_BLOCK, SCOPE_FAILURE, PARSER_FAILURE, USER_CANCELLED, ORCHESTRATION_ABORTED, UNKNOWN).
- When session status is a non-success terminal state (blocked / needs_review / failed — read the real status union in shared types and `deriveSessionState.ts`) AND `failure` exists: render a banner at the very top of ActiveSessionScreen: red/amber left-border card, first line `Blocked: <failure.class>` (human-cased, e.g. `INFRA_BLOCKED` → `Infra blocked`), second line the deterministic `failure.detail` verbatim if present.
- Class-to-severity: USER_CANCELLED → neutral gray banner; INFRA_BLOCKED/TIMEOUT/ORCHESTRATION_ABORTED → amber; everything else → red.
- If `failure` is absent for a non-success state, render NOTHING new (no invented cause).
- Banner links (react-router `Link`) to the verification tab/section for detail.

**Steps:** failing test (session fixture with failure → banner text visible; without failure → absent), implement, full build+test, commit `feat: surface failure cause as session banner`.

### Task 3: Completion notification

**Files:**
- Create: `web/src/state/completionNotify.ts`
- Modify: `web/src/components/layout/AppShell.tsx`
- Test: `web/src/state/completionNotify.test.ts`

**Requirements:**
- Pure helper `completionTitle(base: string, unseenCount: number): string` → `unseenCount === 0` → base, else `"(N) " + base`.
- In AppShell: track sessions observed transitioning from running → terminal while that session is NOT the currently viewed one OR `document.hidden` is true; those are "unseen completions". Update `document.title` via the helper. Clear a session's unseen mark when the user views it (route match) or the window regains focus on that session.
- On transition to terminal, if `"Notification" in window` and `Notification.permission === "granted"`, post `new Notification("Glimmer", { body: "<sessionId short> finished: <status>" })`. NEVER call `Notification.requestPermission()` automatically — instead Settings screen gets an "Enable completion notifications" button that requests permission (modify `web/src/components/settings/SettingsScreen.tsx`, show current permission state as deterministic fact: granted / denied / not asked).
- Works identically in Tauri webview and browser (feature-detect only; zero Tauri-specific code).

**Steps:** failing tests for `completionTitle` + transition detection helper (pure function taking prev/next status maps → newly-completed ids), implement, wire, full build+test, commit `feat: completion notifications (title badge + optional system notification)`.

### Task 4: Command palette + keyboard shortcuts

**Files:**
- Create: `web/src/components/common/CommandPalette.tsx`
- Create: `web/src/state/paletteCommands.ts`
- Modify: `web/src/components/layout/AppShell.tsx`, `web/src/theme.css`
- Test: `web/src/state/paletteCommands.test.ts`, `web/src/components/common/CommandPalette.test.tsx`

**Requirements:**
- Global keydown listener in AppShell (one listener, cleanup on unmount; ignore events when target is input/textarea/contenteditable EXCEPT the palette's own input):
  - `cmd+K` (mac: metaKey; also accept ctrlKey for non-mac) → open palette in command mode.
  - `cmd+P` → open palette in session mode (list sessions, filter, Enter navigates to session).
  - `[` → toggle left sidebar collapsed; `]` → toggle right assistant panel collapsed (reuse the existing collapse state added in polish pass 2). Only when not typing in a field.
  - `Escape` closes palette.
- Palette UI: centered overlay (top third), dark surface-2 card, text input, filtered list, ↑/↓ selection, Enter executes, mouse click executes. Filter = case-insensitive substring on label (simple `includes`, no fuzzy lib).
- `paletteCommands.ts` exports `buildCommands(ctx): PaletteCommand[]` where `PaletteCommand = { id, label, hint?, run(): void }`. Commands: New Task, Go to Dashboard / Sessions / Verification Center / Repository Map / Model Status / Settings, Toggle left panel, Toggle assistant panel, and one entry per known session (label = objective/short id + status) in session mode.
- Filtering helper `filterCommands(commands, query)` pure + tested (empty query → all, substring match, case-insensitive).
- a11y: palette input gets `aria-label="Command palette"`, list uses `role="listbox"` / `role="option"` with `aria-selected`.

**Steps:** failing tests (filterCommands; palette renders + filters + Enter runs command with jsdom), implement, full build+test, commit `feat: command palette (cmd+K/cmd+P) and panel shortcuts`.

### Task 5: Diff syntax highlighting

**Files:**
- Create: `web/src/state/highlight.ts`
- Modify: `web/src/components/diff/DiffReviewScreen.tsx`, `web/src/theme.css`
- Test: `web/src/state/highlight.test.ts`

**Requirements:**
- Hand-rolled line tokenizer, NO dependency. `highlightLine(line: string, lang: Lang): Token[]` with `Token = { text: string, kind: "code" | "keyword" | "string" | "comment" | "number" | "type" }` and `langFromPath(path: string): Lang` (`ts | js | tsx | jsx → "ts"`, `py → "py"`, `css → "css"`, `json → "json"`, `rs → "rs"`, else `"plain"`).
- Tokenizer rules (per line, no multi-line state — a `/* … */` spanning lines may mis-render; acceptable, add a `ponytail:` comment noting the ceiling): strings (`"…"`, `'…'`, `` `…` ``), comments (`//`, `#` for py, `/* … */` within line), numbers, language keyword set (small: ~25 keywords each for ts/py/rs; css: property names before `:`; json: keys). Everything else `code`.
- Tokens must concatenate back to the exact input line (byte-identical) — this is the core test invariant.
- DiffReviewScreen: render added/removed/context line CONTENT through the tokenizer with `<span className="tok-keyword">` etc. Colors in theme.css: muted IDE palette (keyword `#c586c0`-ish desaturated, string `#ce9178`-ish, comment `--text-muted` italic, number `#b5cea8`-ish, type `#4ec9b0`-ish) — must remain readable on both the ±-tinted line backgrounds. Diff markers (+/-), hunk headers, meta lines stay exactly as today (dimmed).
- Apply in unified AND split modes.

**Steps:** failing tests (concat invariant across tricky lines: string containing `//`, keyword inside identifier NOT matched — `constant` is not `const`), implement tokenizer, wire renderer, full build+test, commit `feat: hand-rolled diff syntax highlighting`.

### Task 6: Clickable status bar

**Files:**
- Modify: `web/src/components/layout/AppShell.tsx`, `web/src/theme.css`
- Test: extend AppShell/status bar test

**Requirements:**
- Existing status bar items become buttons (keyboard-focusable, `cursor: pointer`, hover brightens background like VS Code):
  - branch / repo item → navigate to Repository Map screen
  - model status item → Model Status screen
  - session status/verification item → the active session's verification section (or Verification Center when no session open)
- Rendered semantics: `<button class="statusbar-item">` reset-styled; no visual change at rest vs today beyond hover/focus states. `:focus-visible` outline uses `--accent`.
- Purely presentational/navigation — no data changes.

**Steps:** failing test (click model item → route changes, use MemoryRouter), implement, full build+test, commit `feat: clickable status bar items`.

### Task 7: Empty-state action button

**Files:**
- Modify: `web/src/components/common/EmptyState.tsx`
- Modify: call sites that gain an action (at minimum: sessions-empty → "New Task" navigating to composer; diff-empty and any others where an obvious action exists — audit call sites with grep, add actions ONLY where an obvious next step exists)
- Test: `web/src/components/common/EmptyState.test.tsx` (new or extend)

**Requirements:**
- `EmptyState` gains optional `action?: { label: string; onAction(): void }`; renders a small secondary button under the hint text. Without `action`, byte-identical output to today (existing honesty strings preserved verbatim).
- Style: ghost button (border `--border-strong`, text `--text-secondary`, hover accent border).

**Steps:** failing test (with action → button fires callback; without → no button), implement, wire call sites, full build+test, commit `feat: empty-state action buttons`.

### Task 8: Assistant history persistence + streaming

**Files:**
- Modify: `web/src/components/session/SessionAssistant.tsx`
- Modify: `server/src/routes/sessions.ts` (the `/api/sessions/:id/ask` handler)
- Modify: `web/src/api/client.ts`
- Test: server route test extension + `web/src/state/assistantHistory.test.ts`

**Requirements:**
- **Persistence:** turns stored in `sessionStorage` key `glimmer.assistant.<sessionId>` (JSON). Load on mount, save on every turn change, wrapped in try/catch (storage may throw). Pure helpers `loadTurns(sessionId)` / `saveTurns(sessionId, turns)` in `web/src/state/assistantHistory.ts`, tested with a fake storage object.
- **Streaming:** add streaming variant of ask. Server: when client requests `?stream=1` on the ask POST, forward `stream: true` to llama-server and pipe SSE chunks to the client as `text/event-stream` (`data: {"delta": "..."}` events, final `data: {"done": true, "answer": "<full>"}`). Reuse the existing SSE header pattern already in `sessions.ts` (`req.query.stream === "1"` precedent). On upstream error mid-stream: emit `data: {"error": "unavailable"}` and end — client shows the existing Unavailable copy verbatim.
- Client: `askSessionStream(id, question, onDelta): Promise<string>` using `fetch` + ReadableStream reader (no EventSource — POST body needed). SessionAssistant renders the growing partial answer in the bubble; on completion stores the full answer as today. Provenance unchanged (model-output labeling stays).
- Fallback: if streaming fetch fails at connection time, fall back to the existing non-streaming `askSession` once.
- Server tests: mock upstream, assert chunked SSE frames + final done frame + error frame path.

**Steps:** failing tests (history helpers; server stream route), implement server, implement client, full build+test, commit `feat: assistant chat persistence and streaming answers`.

### Task 9: Light theme

**Files:**
- Modify: `web/src/theme.css`
- Modify: `web/src/components/settings/SettingsScreen.tsx`, `web/src/components/layout/AppShell.tsx` (or main.tsx) for applying stored choice
- Create: `web/src/state/themePreference.ts`
- Test: `web/src/state/themePreference.test.ts`

**Requirements:**
- Token-only theming: define light values by redefining the SAME custom properties under `:root[data-theme="light"]` (surface ladder, text ladder, border, accent stays teal but darkened for contrast, status colors darkened variants for white bg). Components already consume tokens only — audit with grep for raw hex in component styles; any raw hex found in components that breaks light mode gets tokenized (add token, keep dark value identical).
- Preference: `themePreference.ts` exports `getTheme(): "dark" | "light" | "system"`, `setTheme(t)`, `resolveTheme(pref, systemPrefersDark): "dark" | "light"`; persisted in `localStorage` key `glimmer.theme`; default `"dark"` (product identity is dark — "system" offered but NOT default).
- Apply: on startup and on change, set `document.documentElement.dataset.theme` to resolved value; listen to `prefers-color-scheme` changes only when pref = system.
- Settings screen: three-way segmented control Dark / Light / System (current value highlighted).
- Acceptance: BOTH themes must pass a manual Playwright screenshot check for: dashboard, active session, diff (unified+split), composer — no unreadable text, no leftover dark surfaces. Dark theme byte-identical tokens (do not change any dark values).

**Steps:** failing tests (resolveTheme matrix; get/set roundtrip fake storage), implement tokens + toggle, screenshot check (controller runs it at review), full build+test, commit `feat: light theme with dark/light/system preference`.

### Task 10: Tauri maturity — real app icon + bundled Node sidecar (auto-update parked)

**Files:**
- Create: `src-tauri/icons/*` regenerated from a new source icon (controller supplies `icon-source.png`)
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs` (or lib.rs where gateway spawn lives)
- Docs: `docs/tauri-notes.md` update

**Requirements:**
- **Icon:** design a real Glimmer icon (dark rounded square, teal `#5fb3ad` glyph — a spark/asterisk "glimmer" mark), 1024×1024 PNG, run `npx tauri icon <src>` (CLI already in devDependencies of root or src-tauri context — verify; it regenerates icns/ico/pngs).
- **Node sidecar:** bundle a `node` binary as Tauri sidecar (`externalBin`): copy the machine's current `node` (arm64) to `src-tauri/binaries/node-aarch64-apple-darwin`, add to `tauri.conf.json` `bundle.externalBin`, and change the Rust gateway spawn to prefer the sidecar path (resolve via Tauri's sidecar API / `process.Command::new_sidecar` equivalent in Tauri 2: `tauri_plugin_shell` if already present — check what's used today) with fallback to `node` on PATH (dev mode keeps working without the binary present).
- **Auto-update: PARKED.** Requires signing keys + a release/update endpoint that doesn't exist. Document in `docs/tauri-notes.md`: what tauri-plugin-updater needs (public key in conf, signed artifacts, update JSON endpoint) so it's a follow-up, not silently dropped.
- Verify: `cargo check` in src-tauri passes; dev run unaffected; note in docs that the sidecar binary is gitignored (add to .gitignore — 80MB binary never committed) and produced by a script `src-tauri/scripts/prepare-sidecar.sh` (create it: copies `$(command -v node)` to the triple-named path).

**Steps:** icon source + generate, sidecar script + conf + Rust fallback logic, `cargo check`, full build+test (workspace), commit `feat: tauri app icon and bundled node sidecar (auto-update parked)`.
