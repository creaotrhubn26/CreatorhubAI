// Task 4c(2/3): native path picking, desktop only.
//
// Inside the Tauri shell this opens a real Finder chooser through the official
// Tauri v2 dialog plugin. Outside it (browser/dev, and every vitest run) there
// is no Tauri IPC at all, so this returns null and the caller falls back to the
// gateway's read-only directory browser (GET /api/fs/dirs). Same feature-
// detection discipline as desktopNotify.ts: the plugin module is imported
// dynamically and ONLY after window.__TAURI__ is confirmed present, so the
// browser bundle never evaluates Tauri code.
import { tauriGlobal } from "./desktopNotify";

export function nativePickerAvailable(): boolean {
  return tauriGlobal() !== null;
}

/**
 * null  -> no native dialog here (caller must use the in-app browser)
 * []    -> the user cancelled
 * [...] -> absolute paths the user chose
 */
export async function pickPathsNatively(opts: {
  directory: boolean;
  multiple: boolean;
  defaultPath?: string;
  title?: string;
}): Promise<string[] | null> {
  if (!nativePickerAvailable()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = (await open({
    directory: opts.directory,
    multiple: opts.multiple,
    ...(opts.defaultPath ? { defaultPath: opts.defaultPath } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  })) as unknown as string | string[] | null;
  if (selected === null) return [];
  return Array.isArray(selected) ? selected : [selected];
}
