// Desktop (Tauri) notification bridge. WKWebView has no window.Notification,
// so inside the Tauri shell (withGlobalTauri exposes window.__TAURI__) the
// completion notification goes through the Rust `notify` command instead of
// the Web Notification API. Pure feature detection — zero Tauri imports, so
// the browser build is unaffected.

interface TauriGlobal {
  core: { invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> };
}

export function tauriGlobal(): TauriGlobal | null {
  const t = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t && typeof t.core?.invoke === "function" ? t : null;
}

// Sends a completion notification through whichever channel this
// environment supports: the Tauri command in the desktop app, the Web
// Notification API (permission-gated) in a browser, or nothing.
export function sendCompletionNotification(title: string, body: string): void {
  const tauri = tauriGlobal();
  if (tauri) {
    // macOS gates delivery behind its own per-app permission prompt on
    // first use — no requestPermission() dance on our side.
    void tauri.core.invoke("notify", { title, body }).catch(() => {});
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
