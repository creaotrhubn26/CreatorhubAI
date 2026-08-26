import { tauriGlobal } from "./desktopNotify";

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  notes?: string;
}

export interface AppUpdateCheck {
  supported: boolean;
  update: AppUpdateInfo | null;
}

export interface AppUpdateProgress {
  downloadedBytes: number;
  totalBytes?: number;
  finished: boolean;
}

type PendingUpdate = Awaited<ReturnType<(typeof import("@tauri-apps/plugin-updater"))["check"]>>;

let pendingUpdate: PendingUpdate = null;
const PENDING_UPDATE_KEY = "glimmer.pendingUpdateSmoke";

export interface PendingUpdateSmoke {
  fromVersion: string;
  toVersion: string;
  installedAt: string;
}

export function readPendingUpdateSmoke(): PendingUpdateSmoke | null {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(PENDING_UPDATE_KEY) ?? "null");
    if (
      !parsed ||
      typeof parsed.fromVersion !== "string" ||
      typeof parsed.toVersion !== "string" ||
      typeof parsed.installedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingUpdateSmoke(): void {
  try {
    window.localStorage?.removeItem(PENDING_UPDATE_KEY);
  } catch {
    // A restricted webview can still update; it simply cannot persist smoke-test state.
  }
}

function recordPendingUpdateSmoke(update: { currentVersion: string; version: string }): void {
  try {
    window.localStorage?.setItem(
      PENDING_UPDATE_KEY,
      JSON.stringify({
        fromVersion: update.currentVersion,
        toVersion: update.version,
        installedAt: new Date().toISOString(),
      } satisfies PendingUpdateSmoke),
    );
  } catch {
    // See clearPendingUpdateSmoke: update installation must not depend on storage availability.
  }
}

export function appUpdaterSupported(): boolean {
  return tauriGlobal() !== null;
}

export async function getInstalledAppVersion(): Promise<string | null> {
  if (!appUpdaterSupported()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function checkForAppUpdate(): Promise<AppUpdateCheck> {
  if (!appUpdaterSupported()) return { supported: false, update: null };

  if (pendingUpdate) {
    await pendingUpdate.close().catch(() => undefined);
    pendingUpdate = null;
  }

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 30_000 });
  pendingUpdate = update;

  return {
    supported: true,
    update: update
      ? {
          currentVersion: update.currentVersion,
          version: update.version,
          date: update.date,
          notes: update.body,
        }
      : null,
  };
}

export async function downloadAndInstallAppUpdate(
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<void> {
  const update = pendingUpdate;
  if (!update) throw new Error("Check for an update before installing it.");

  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength;
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
    }
    onProgress({
      downloadedBytes,
      totalBytes,
      finished: event.event === "Finished",
    });
  });
  recordPendingUpdateSmoke(update);
  pendingUpdate = null;
}

export async function restartApp(): Promise<void> {
  if (!appUpdaterSupported()) throw new Error("Restart is available only in the desktop app.");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
