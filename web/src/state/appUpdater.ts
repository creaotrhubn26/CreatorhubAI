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
  pendingUpdate = null;
}

export async function restartApp(): Promise<void> {
  if (!appUpdaterSupported()) throw new Error("Restart is available only in the desktop app.");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
