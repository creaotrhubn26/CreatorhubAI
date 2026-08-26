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
//! Python/orchestrator location: packaged builds ship `Contents/MacOS/python3`
//! plus `Resources/binaries/runtime/{python,orchestrator}`. The gateway gets
//! explicit GLIMMER_* paths and PYTHONHOME for those resources. Environment
//! overrides stay authoritative, and development builds still fall back to
//! the external `~/AI/muse-glimmer` checkout and `python3` on PATH.
//!
//! PATH: a GUI-launched .app inherits launchd's minimal PATH, which has no
//! node/npm — so the gateway child gets an explicitly resolved PATH (see
//! `resolve_user_path`), which is what glimmer-v2.py and every verification
//! command it runs will inherit.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewaySupervisorStatus {
    state: String,
    detail: String,
    pid: Option<u32>,
    restart_count: u32,
    last_error: Option<String>,
}

struct GatewaySupervisorInner {
    child: Option<Child>,
    shutdown: bool,
    status: GatewaySupervisorStatus,
}

/// Owns only children started by this app. A healthy Glimmer gateway already
/// on 4317 is adopted without taking process ownership; an unknown listener is
/// reported and re-probed, never killed.
struct GatewaySupervisor(Mutex<GatewaySupervisorInner>);

impl GatewaySupervisor {
    fn new() -> Self {
        Self(Mutex::new(GatewaySupervisorInner {
            child: None,
            shutdown: false,
            status: GatewaySupervisorStatus {
                state: "starting".into(),
                detail: "Checking the local gateway port.".into(),
                pid: None,
                restart_count: 0,
                last_error: None,
            },
        }))
    }
}

struct BundledRuntime {
    python: PathBuf,
    python_home: PathBuf,
    orchestrator_root: PathBuf,
}

fn gateway_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("GLIMMER_GATEWAY_DIR") {
        return PathBuf::from(dir);
    }

    // Bundled resource, produced by scripts/prepare-gateway.sh (see
    // tauri.conf.json's bundle.resources). Present in release bundles, and
    // in debug builds too once the script has been run — tauri-build copies
    // `bundle.resources` at compile time (build.rs), not just at `tauri
    // build` time, so this also works under plain `cargo run`/`tauri dev`.
    if let Some(resource_dir) = app
        .path()
        .resolve("resources/gateway", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|resource_dir| resource_dir.join("dist/index.js").exists())
    {
        return resource_dir;
    }

    // Dev fallback: compile-time repo path, only meaningful for a debug
    // build run from a checkout that hasn't produced the bundled resource
    // yet. A release build shipped to another machine has no such repo, so
    // this branch is compiled out there.
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server")
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
        .find(is_executable)
}

fn prepend_to_path(path: &str, directory: &std::path::Path) -> String {
    let directory = directory.to_string_lossy();
    if path.is_empty() {
        directory.into_owned()
    } else {
        format!("{directory}:{path}")
    }
}

fn prepend_absolute_executable_parent(path: &str, executable: &std::path::Path) -> String {
    if executable.is_absolute() {
        executable
            .parent()
            .map(|parent| prepend_to_path(path, parent))
            .unwrap_or_else(|| path.to_owned())
    } else {
        path.to_owned()
    }
}

#[cfg(test)]
mod runtime_path_tests {
    use super::{
        GatewayProbe, classify_health_response, prepend_absolute_executable_parent, restart_backoff,
    };
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn prepends_the_parent_of_an_absolute_bundled_executable() {
        assert_eq!(
            prepend_absolute_executable_parent("/usr/bin", Path::new("/Applications/app/python3")),
            "/Applications/app:/usr/bin"
        );
    }

    #[test]
    fn does_not_introduce_an_empty_path_entry_for_a_relative_override() {
        assert_eq!(
            prepend_absolute_executable_parent("/usr/bin", Path::new("python3")),
            "/usr/bin"
        );
    }

    #[test]
    fn identifies_only_the_glimmer_health_contract_as_healthy() {
        assert_eq!(
            classify_health_response(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"service\":\"glimmer-gateway\",\"status\":\"ok\"}"
            ),
            GatewayProbe::Healthy
        );
        assert_eq!(
            classify_health_response("HTTP/1.1 200 OK\r\n\r\nhello"),
            GatewayProbe::Occupied
        );
    }

    #[test]
    fn restart_backoff_is_bounded() {
        assert_eq!(restart_backoff(1), Duration::from_millis(250));
        assert_eq!(restart_backoff(3), Duration::from_secs(1));
        assert_eq!(restart_backoff(99), Duration::from_secs(4));
    }
}

fn bundled_runtime(app: &tauri::AppHandle) -> Option<BundledRuntime> {
    let python = std::env::current_exe()
        .ok()?
        .parent()?
        .join(if cfg!(windows) {
            "python3.exe"
        } else {
            "python3"
        });
    let python_home = app
        .path()
        .resolve(
            "binaries/runtime/python",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    let orchestrator_root = app
        .path()
        .resolve(
            "binaries/runtime/orchestrator",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;

    let required = [
        python_home.join("lib/python3.13/os.py"),
        python_home.join("ORIGIN.json"),
        orchestrator_root.join("glimmer-v2.py"),
        orchestrator_root.join("glimmer-engineer.py"),
    ];
    if is_executable(&python) && required.iter().all(|path| path.is_file()) {
        Some(BundledRuntime {
            python,
            python_home,
            orchestrator_root,
        })
    } else {
        None
    }
}

/// A *runnable* file, not just a file: a non-executable `node` earlier in PATH
/// would otherwise be picked and fail at spawn with a confusing error.
fn is_executable(path: &PathBuf) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
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
                eprintln!(
                    "[glimmer] login shell ({shell}) did not report its PATH within {SHELL_PATH_TIMEOUT:?} — killing it and falling back."
                );
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
            println!(
                "[glimmer] PATH resolved from login shell (node at {}): {shell_path}",
                node.display()
            );
            return shell_path;
        }
        eprintln!(
            "[glimmer] login shell PATH contains no node — falling back to the standard locations. Shell PATH was: {shell_path}"
        );
    } else {
        eprintln!(
            "[glimmer] could not read the login shell's PATH — falling back to the standard locations."
        );
    }

    let mut dirs: Vec<&str> = FALLBACK_PATH_DIRS.to_vec();
    dirs.extend(
        inherited
            .split(':')
            .filter(|d| !d.is_empty() && !FALLBACK_PATH_DIRS.contains(d)),
    );
    let fallback = dirs.join(":");
    match find_in_path(&fallback, "node") {
        Some(node) => println!(
            "[glimmer] PATH resolved from fallback locations (node at {}): {fallback}",
            node.display()
        ),
        None => eprintln!(
            "[glimmer] PATH resolved from fallback locations but NO node was found in it: {fallback}. The gateway will start, but verification commands (npm run typecheck, ...) will fail with 'command not found'."
        ),
    }
    fallback
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GatewayProbe {
    Healthy,
    Occupied,
    Unavailable,
}

fn classify_health_response(response: &str) -> GatewayProbe {
    let status_ok = response
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "));
    if status_ok && response.contains("\"service\":\"glimmer-gateway\"") {
        GatewayProbe::Healthy
    } else {
        GatewayProbe::Occupied
    }
}

fn probe_gateway(port: u16) -> GatewayProbe {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, GATEWAY_PROBE_TIMEOUT) else {
        return GatewayProbe::Unavailable;
    };
    let _ = stream.set_read_timeout(Some(GATEWAY_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(GATEWAY_PROBE_TIMEOUT));
    if stream
        .write_all(
            format!(
                "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .is_err()
    {
        return GatewayProbe::Occupied;
    }
    let mut response = Vec::with_capacity(4096);
    let mut buffer = [0_u8; 1024];
    while response.len() < 8192 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response
                    .windows(b"\"service\":\"glimmer-gateway\"".len())
                    .any(|window| window == b"\"service\":\"glimmer-gateway\"")
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if response.is_empty() {
        GatewayProbe::Occupied
    } else {
        classify_health_response(&String::from_utf8_lossy(&response))
    }
}

/// Spawns `node dist/index.js`. Port ownership is decided by the supervisor
/// before this function is called, so this function never guesses that an
/// arbitrary listener is Glimmer.
fn spawn_gateway(app: &tauri::AppHandle) -> Result<Child, String> {
    let dir = gateway_dir(app);
    let entry = dir.join("dist/index.js");
    if !entry.exists() {
        return Err(format!(
            "Gateway entrypoint not found at {}. Build the server or reinstall Glimmer.",
            entry.display()
        ));
    }

    // Resolved before the spawn and passed explicitly: the child's env is the
    // only thing that reaches glimmer-v2.py and the verification subprocesses
    // it runs. It also decides where `node` itself is found when no sidecar
    // is bundled (dev), so don't rely on the ambiguous execvp PATH lookup.
    let mut path = resolve_user_path();
    let node = node_binary(&path);
    let mut command = Command::new(&node);
    command.arg("dist/index.js").current_dir(&dir);

    if let Some(runtime) = bundled_runtime(app) {
        let configured_python = std::env::var_os("GLIMMER_PYTHON_PATH").map(PathBuf::from);
        let python = configured_python
            .as_ref()
            .unwrap_or(&runtime.python)
            .to_path_buf();
        // A relative user override such as `python3` should be resolved by
        // the existing PATH. Its parent is the empty path; prepending that
        // would introduce an empty PATH entry and make the gateway search its
        // writable working directory for unrelated commands.
        path = prepend_absolute_executable_parent(&path, &python);
        command.env("GLIMMER_PYTHON_PATH", &python);
        if configured_python.is_none() {
            command.env("PYTHONHOME", &runtime.python_home);
            command.env("GLIMMER_PYTHON_BUNDLED", "1");
        }
        command.env("PYTHONDONTWRITEBYTECODE", "1");

        let v2_overridden = std::env::var_os("GLIMMER_V2_PATH").is_some();
        let engineer_overridden = std::env::var_os("GLIMMER_ENGINEER_PATH").is_some();
        if !v2_overridden {
            command.env(
                "GLIMMER_V2_PATH",
                runtime.orchestrator_root.join("glimmer-v2.py"),
            );
        }
        if !engineer_overridden {
            command.env(
                "GLIMMER_ENGINEER_PATH",
                runtime.orchestrator_root.join("glimmer-engineer.py"),
            );
        }
        if !v2_overridden && !engineer_overridden {
            command.env("GLIMMER_ORCHESTRATOR_BUNDLED", "1");
        }

        println!(
            "[glimmer] bundled runtime: Python {} with PYTHONHOME {} and orchestrator {}",
            python.display(),
            runtime.python_home.display(),
            runtime.orchestrator_root.display()
        );
    } else {
        println!(
            "[glimmer] bundled Python/orchestrator resources not found — using configured development runtime."
        );
    }

    command.env("PATH", &path);
    command.env(
        "GLIMMER_APP_VERSION",
        app.package_info().version.to_string(),
    );
    match command.spawn() {
        Ok(child) => {
            println!(
                "[glimmer] spawned gateway (pid {}) from {} via {}",
                child.id(),
                dir.display(),
                node.display()
            );
            Ok(child)
        }
        Err(err) => Err(format!(
            "Failed to spawn the gateway via {}: {err}",
            node.display()
        )),
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
    let sidecar = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent().map(|dir| {
                dir.join(if cfg!(windows) {
                    "glimmer-node.exe"
                } else {
                    "glimmer-node"
                })
            })
        })
        .filter(|sidecar| sidecar.exists());
    if let Some(sidecar) = sidecar {
        return sidecar;
    }
    find_in_path(path, "node").unwrap_or_else(|| PathBuf::from("node"))
}

fn restart_backoff(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(4);
    Duration::from_millis(250_u64.saturating_mul(1_u64 << exponent)).min(Duration::from_secs(4))
}

fn update_supervisor_status(
    state: &GatewaySupervisor,
    status: &str,
    detail: impl Into<String>,
    pid: Option<u32>,
    last_error: Option<String>,
) {
    if let Ok(mut guard) = state.0.lock() {
        guard.status.state = status.into();
        guard.status.detail = detail.into();
        guard.status.pid = pid;
        guard.status.last_error = last_error;
    }
}

fn supervisor_should_stop(state: &GatewaySupervisor) -> bool {
    state.0.lock().map(|guard| guard.shutdown).unwrap_or(true)
}

fn gateway_supervisor_loop(app: tauri::AppHandle) {
    let mut next_spawn = Instant::now();
    let mut unhealthy_ticks = 0_u8;

    loop {
        let state = app.state::<GatewaySupervisor>();
        if supervisor_should_stop(&state) {
            return;
        }

        let mut child_exit: Option<String> = None;
        let mut child_pid = None;
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.child.as_mut() {
                child_pid = Some(child.id());
                match child.try_wait() {
                    Ok(Some(exit)) => child_exit = Some(format!("Gateway exited with {exit}.")),
                    Ok(None) => {}
                    Err(error) => {
                        child_exit = Some(format!("Could not inspect gateway process: {error}"))
                    }
                }
            }
            if child_exit.is_some() {
                guard.child.take();
                guard.status.restart_count = guard.status.restart_count.saturating_add(1);
            }
        }

        if let Some(error) = child_exit {
            let attempt = state
                .0
                .lock()
                .map(|guard| guard.status.restart_count)
                .unwrap_or(1);
            let delay = restart_backoff(attempt);
            next_spawn = Instant::now() + delay;
            update_supervisor_status(
                &state,
                "restarting",
                format!("{error} Restarting in {:.2}s.", delay.as_secs_f32()),
                None,
                Some(error),
            );
            unhealthy_ticks = 0;
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }

        if let Some(pid) = child_pid {
            match probe_gateway(GATEWAY_PORT) {
                GatewayProbe::Healthy => {
                    unhealthy_ticks = 0;
                    update_supervisor_status(
                        &state,
                        "running",
                        "The app-owned gateway is healthy.",
                        Some(pid),
                        None,
                    );
                }
                GatewayProbe::Occupied | GatewayProbe::Unavailable => {
                    unhealthy_ticks = unhealthy_ticks.saturating_add(1);
                    update_supervisor_status(
                        &state,
                        "starting",
                        "The gateway process is running but has not become healthy yet.",
                        Some(pid),
                        None,
                    );
                    // A process that stays alive but never serves its health
                    // contract is owned by us and safe to recycle. Unknown
                    // processes on the same port are never touched.
                    if unhealthy_ticks >= 20 {
                        let child = state.0.lock().ok().and_then(|mut guard| {
                            guard.status.restart_count =
                                guard.status.restart_count.saturating_add(1);
                            guard.child.take()
                        });
                        if let Some(mut child) = child {
                            let error = "The gateway did not become healthy within 10 seconds.";
                            eprintln!("[glimmer] {error} Recycling pid {}.", child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                            next_spawn = Instant::now() + Duration::from_millis(250);
                            update_supervisor_status(
                                &state,
                                "restarting",
                                error,
                                None,
                                Some(error.into()),
                            );
                        }
                        unhealthy_ticks = 0;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }

        match probe_gateway(GATEWAY_PORT) {
            GatewayProbe::Healthy => {
                update_supervisor_status(
                    &state,
                    "external_gateway",
                    "A healthy Glimmer gateway already owns port 4317; this app is using it without taking process ownership.",
                    None,
                    None,
                );
                next_spawn = Instant::now();
            }
            GatewayProbe::Occupied => {
                update_supervisor_status(
                    &state,
                    "port_conflict",
                    "Port 4317 is occupied by a service that is not a Glimmer gateway. Close that service or change its port; Glimmer will retry automatically.",
                    None,
                    Some("Unknown service occupies port 4317.".into()),
                );
                next_spawn = Instant::now();
            }
            GatewayProbe::Unavailable if Instant::now() >= next_spawn => {
                update_supervisor_status(
                    &state,
                    "starting",
                    "Starting the local gateway.",
                    None,
                    None,
                );
                match spawn_gateway(&app) {
                    Ok(child) => {
                        let pid = child.id();
                        if let Ok(mut guard) = state.0.lock() {
                            guard.child = Some(child);
                            guard.status.pid = Some(pid);
                        }
                        unhealthy_ticks = 0;
                    }
                    Err(error) => {
                        let attempt = if let Ok(mut guard) = state.0.lock() {
                            guard.status.restart_count =
                                guard.status.restart_count.saturating_add(1);
                            guard.status.restart_count
                        } else {
                            1
                        };
                        next_spawn = Instant::now() + restart_backoff(attempt);
                        eprintln!("[glimmer] {error}");
                        update_supervisor_status(
                            &state,
                            "error",
                            "The gateway could not be started; Glimmer will retry automatically.",
                            None,
                            Some(error),
                        );
                    }
                }
            }
            GatewayProbe::Unavailable => {}
        }
        std::thread::sleep(Duration::from_millis(500));
    }
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

#[tauri::command]
fn gateway_supervisor_status(
    state: tauri::State<'_, GatewaySupervisor>,
) -> GatewaySupervisorStatus {
    state
        .0
        .lock()
        .map(|guard| guard.status.clone())
        .unwrap_or(GatewaySupervisorStatus {
            state: "error".into(),
            detail: "Gateway supervisor state is unavailable.".into(),
            pid: None,
            restart_count: 0,
            last_error: Some("Supervisor state lock failed.".into()),
        })
}

fn kill_gateway(state: &GatewaySupervisor) {
    let child = state.0.lock().ok().and_then(|mut guard| {
        guard.shutdown = true;
        guard.status.state = "stopped".into();
        guard.status.detail = "The application is shutting down.".into();
        guard.status.pid = None;
        guard.child.take()
    });
    if let Some(mut child) = child {
        println!("[glimmer] stopping gateway (pid {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Restart is exposed separately from installation so the user keeps
        // control over when an already-downloaded update takes effect.
        .plugin(tauri_plugin_process::init())
        // Task 4c(2/3): native directory/file chooser for the task composer.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![notify, gateway_supervisor_status])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(GatewaySupervisor::new());
            std::thread::Builder::new()
                .name("glimmer-gateway-supervisor".into())
                .spawn(move || gateway_supervisor_loop(handle))?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<GatewaySupervisor>();
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
                let state = app_handle.state::<GatewaySupervisor>();
                kill_gateway(&state);
            }
            _ => {}
        }
    });
}
