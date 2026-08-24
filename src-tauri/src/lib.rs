//! Glimmer Control Center — Tauri desktop shell.
//!
//! Spawns the Express gateway (`server/dist/index.js`, port 4317) as a child
//! process on startup and kills it when the app exits. The webview loads the
//! built web UI and talks to the gateway over `http://127.0.0.1:4317` exactly
//! as it does when run outside Tauri.
//!
//! Gateway location: resolved from the `GLIMMER_GATEWAY_DIR` env var first;
//! otherwise the bundled resource dir (`resources/gateway`, a self-contained
//! copy of `server/dist` + `@glimmer/shared` + prod node_modules produced by
//! `scripts/prepare-gateway.sh` and shipped via `bundle.resources`) if
//! present there; otherwise, in debug builds only, the compile-time repo
//! path (`CARGO_MANIFEST_DIR/../server`) so `cargo run`/`tauri dev` works
//! straight from a checkout without running the prepare script first. Node
//! itself is bundled: `node_binary()` prefers the sidecar shipped via
//! `bundle.externalBin` (see scripts/prepare-sidecar.sh), falling back to
//! `node` on PATH in dev.
//!
//! PATH: a GUI-launched .app inherits launchd's minimal PATH, which has no
//! node/npm — so the gateway child gets an explicitly resolved PATH (see
//! `resolve_user_path`), which is what glimmer-v2.py and every verification
//! command it runs will inherit.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WindowEvent};

const GATEWAY_PORT: u16 = 4317;
const GATEWAY_PROBE_TIMEOUT: Duration = Duration::from_millis(300);
/// Login shells can be slow (nvm, rbenv, conda init...). Long enough for a
/// realistic rc chain, short enough that a broken/hanging profile can't hold
/// app startup hostage — on timeout we fall back instead of waiting.
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(5);
/// Where node/npm actually live on a developer Mac. Only used as a fallback
/// when the login shell can't be asked (see `resolve_user_path`).
const FALLBACK_PATH_DIRS: [&str; 3] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Holds the spawned gateway child process, if this app instance started one.
/// `None` means either the gateway wasn't spawned (port already in use) or it
/// has already been reaped.
struct GatewayChild(Mutex<Option<Child>>);

fn gateway_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("GLIMMER_GATEWAY_DIR") {
        return PathBuf::from(dir);
    }

    // Bundled resource, produced by scripts/prepare-gateway.sh (see
    // tauri.conf.json's bundle.resources). Present in release bundles, and
    // in debug builds too once the script has been run — tauri-build copies
    // `bundle.resources` at compile time (build.rs), not just at `tauri
    // build` time, so this also works under plain `cargo run`/`tauri dev`.
    if let Ok(resource_dir) = app.path().resolve("resources/gateway", tauri::path::BaseDirectory::Resource) {
        if resource_dir.join("dist/index.js").exists() {
            return resource_dir;
        }
    }

    // Dev fallback: compile-time repo path, only meaningful for a debug
    // build run from a checkout that hasn't produced the bundled resource
    // yet. A release build shipped to another machine has no such repo, so
    // this branch is compiled out there.
    #[cfg(debug_assertions)]
    {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server");
    }
    #[cfg(not(debug_assertions))]
    {
        PathBuf::from("")
    }
}

/// First directory of `path` (a `:`-separated PATH) holding an executable
/// named `program`. Also the honest answer to "is node actually reachable?".
fn find_in_path(path: &str, program: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join(program))
        .find(|candidate| candidate.is_file())
}

/// Asks the user's login shell for its PATH, exactly as a Terminal session
/// would see it. `-i` so interactive-only rc files (the usual home of
/// nvm/homebrew shims) are sourced too. The marker keeps us honest about
/// which output line is the PATH: an interactive rc file is free to print
/// banners, and mistaking one for a PATH is how you end up with a PATH that
/// silently contains nothing.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf '__GLIMMER_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + SHELL_PATH_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                eprintln!("[glimmer] login shell ({shell}) did not report its PATH within {SHELL_PATH_TIMEOUT:?} — killing it and falling back.");
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("__GLIMMER_PATH__"))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// The PATH the gateway child (and therefore glimmer-v2.py, and therefore the
/// verification commands it runs — `npm run typecheck` and friends) will see.
///
/// A GUI-launched .app inherits launchd's minimal PATH (`/usr/bin:/bin:
/// /usr/sbin:/sbin`), which has no node and no npm: every real task in the
/// packaged app died as INFRA_BLOCKED with `npm: command not found`. So ask
/// the login shell once at startup; if that fails, times out, or yields a
/// PATH without node, prepend the standard install locations to whatever we
/// inherited. Whatever happens is logged, including the case where node is
/// still not found — never silently proceed pretending it's fine.
fn resolve_user_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();

    if let Some(shell_path) = login_shell_path() {
        if let Some(node) = find_in_path(&shell_path, "node") {
            println!("[glimmer] PATH resolved from login shell (node at {}): {shell_path}", node.display());
            return shell_path;
        }
        eprintln!("[glimmer] login shell PATH contains no node — falling back to the standard locations. Shell PATH was: {shell_path}");
    } else {
        eprintln!("[glimmer] could not read the login shell's PATH — falling back to the standard locations.");
    }

    let mut dirs: Vec<&str> = FALLBACK_PATH_DIRS.to_vec();
    dirs.extend(inherited.split(':').filter(|d| !d.is_empty() && !FALLBACK_PATH_DIRS.contains(d)));
    let fallback = dirs.join(":");
    match find_in_path(&fallback, "node") {
        Some(node) => println!("[glimmer] PATH resolved from fallback locations (node at {}): {fallback}", node.display()),
        None => eprintln!(
            "[glimmer] PATH resolved from fallback locations but NO node was found in it: {fallback}. The gateway will start, but verification commands (npm run typecheck, ...) will fail with 'command not found'."
        ),
    }
    fallback
}

fn port_in_use(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, GATEWAY_PROBE_TIMEOUT).is_ok()
}

/// Spawns `node dist/index.js` in the gateway dir, unless something is
/// already listening on the gateway port (typical in `tauri dev`, where
/// `npm --prefix server run dev` is usually already running). Never panics —
/// a missing checkout or missing `node` is logged, not fatal, since the web
/// UI already degrades honestly ("Unavailable") when the API is unreachable.
fn spawn_gateway(app: &tauri::AppHandle) -> Option<Child> {
    if port_in_use(GATEWAY_PORT) {
        println!(
            "[glimmer] port {GATEWAY_PORT} already in use — assuming the gateway is already running, not spawning another."
        );
        return None;
    }

    let dir = gateway_dir(app);
    let entry = dir.join("dist/index.js");
    if !entry.exists() {
        eprintln!(
            "[glimmer] gateway entrypoint not found at {}. Build it with `npm --prefix server run build`, or point GLIMMER_GATEWAY_DIR at a built server. The UI will show 'Unavailable' until the gateway is reachable.",
            entry.display()
        );
        return None;
    }

    // Resolved before the spawn and passed explicitly: the child's env is the
    // only thing that reaches glimmer-v2.py and the verification subprocesses
    // it runs. It also decides where `node` itself is found when no sidecar
    // is bundled (dev), so don't rely on the ambiguous execvp PATH lookup.
    let path = resolve_user_path();
    let node = node_binary(&path);
    match Command::new(&node)
        .arg("dist/index.js")
        .current_dir(&dir)
        .env("PATH", &path)
        .spawn()
    {
        Ok(child) => {
            println!(
                "[glimmer] spawned gateway (pid {}) from {} via {}",
                child.id(),
                dir.display(),
                node.display()
            );
            Some(child)
        }
        Err(err) => {
            eprintln!(
                "[glimmer] failed to spawn gateway via {}: {err}. Is node on PATH?",
                node.display()
            );
            None
        }
    }
}

/// Prefer the bundled node sidecar (Tauri places `externalBin` entries next
/// to the app executable — `Contents/MacOS/glimmer-node` on macOS; named
/// glimmer-node so a linux package never shadows /usr/bin/node), falling
/// back to `node` on PATH so `tauri dev` and repo-checkout runs keep working
/// without the ~50MB binary present (it's gitignored; produced by
/// `scripts/prepare-sidecar.sh` before a bundling build). The fallback looks
/// `node` up in the resolved user PATH rather than leaving it to the OS's
/// exec lookup, which searches the *parent's* PATH — the launchd one that
/// started this whole bug.
fn node_binary(path: &str) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(if cfg!(windows) { "glimmer-node.exe" } else { "glimmer-node" });
            if sidecar.exists() {
                return sidecar;
            }
        }
    }
    find_in_path(path, "node").unwrap_or_else(|| PathBuf::from("node"))
}

/// Desktop notification bridge: WKWebView has no `window.Notification`, so
/// the web UI invokes this command (via `window.__TAURI__.core.invoke`)
/// instead when running inside Tauri. Body text is the same deterministic
/// "<session> finished: <status>" string the browser path uses.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[glimmer] notification failed: {err}");
    }
}

fn kill_gateway(state: &GatewayChild) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            println!("[glimmer] stopping gateway (pid {})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![notify])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(GatewayChild(Mutex::new(spawn_gateway(&handle))));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<GatewayChild>();
                kill_gateway(&state);
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building the Glimmer Control Center app");

    app.run(|app_handle, event| {
        // Both variants matter: ExitRequested fires when the last window
        // closes; a macOS Cmd+Q / Dock "Quit" instead goes straight to Exit
        // without ever hitting WindowEvent::Destroyed first. Kill on either
        // so the gateway never survives the app.
        match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                let state = app_handle.state::<GatewayChild>();
                kill_gateway(&state);
            }
            _ => {}
        }
    });
}
