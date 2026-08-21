//! Glimmer Control Center — Tauri desktop shell.
//!
//! Spawns the Express gateway (`server/dist/index.js`, port 4317) as a child
//! process on startup and kills it when the app exits. The webview loads the
//! built web UI and talks to the gateway over `http://127.0.0.1:4317` exactly
//! as it does when run outside Tauri.
//!
//! Gateway location: resolved from the `GLIMMER_GATEWAY_DIR` env var, falling
//! back to `<repo>/server` (baked in at compile time via `CARGO_MANIFEST_DIR`,
//! since `src-tauri/` lives at the repo root). This requires the repo
//! checkout + a built server (`npm --prefix server run build`) + `node` on
//! PATH — see the report for why a bundled sidecar is future work, not this
//! pass.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WindowEvent};

const GATEWAY_PORT: u16 = 4317;
const GATEWAY_PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// Holds the spawned gateway child process, if this app instance started one.
/// `None` means either the gateway wasn't spawned (port already in use) or it
/// has already been reaped.
struct GatewayChild(Mutex<Option<Child>>);

fn gateway_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("GLIMMER_GATEWAY_DIR") {
        return PathBuf::from(dir);
    }
    // src-tauri/ sits at the repo root, so the server dir is a sibling.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server")
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
fn spawn_gateway() -> Option<Child> {
    if port_in_use(GATEWAY_PORT) {
        println!(
            "[glimmer] port {GATEWAY_PORT} already in use — assuming the gateway is already running, not spawning another."
        );
        return None;
    }

    let dir = gateway_dir();
    let entry = dir.join("dist/index.js");
    if !entry.exists() {
        eprintln!(
            "[glimmer] gateway entrypoint not found at {}. Build it with `npm --prefix server run build`, or point GLIMMER_GATEWAY_DIR at a built server. The UI will show 'Unavailable' until the gateway is reachable.",
            entry.display()
        );
        return None;
    }

    match Command::new("node").arg("dist/index.js").current_dir(&dir).spawn() {
        Ok(child) => {
            println!("[glimmer] spawned gateway (pid {}) from {}", child.id(), dir.display());
            Some(child)
        }
        Err(err) => {
            eprintln!("[glimmer] failed to spawn gateway via `node`: {err}. Is node on PATH?");
            None
        }
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
        .setup(|app| {
            app.manage(GatewayChild(Mutex::new(spawn_gateway())));
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
