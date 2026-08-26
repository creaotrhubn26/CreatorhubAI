import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauriGlobal: vi.fn(),
  getVersion: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("./desktopNotify", () => ({ tauriGlobal: mocks.tauriGlobal }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

beforeEach(() => {
  vi.resetModules();
  mocks.tauriGlobal.mockReturnValue({ core: { invoke: vi.fn() } });
  mocks.getVersion.mockResolvedValue("0.2.0");
  mocks.check.mockResolvedValue(null);
  mocks.relaunch.mockResolvedValue(undefined);
});

describe("appUpdater", () => {
  it("never checks from a browser", async () => {
    mocks.tauriGlobal.mockReturnValue(null);
    const { checkForAppUpdate, getInstalledAppVersion } = await import("./appUpdater");

    await expect(checkForAppUpdate()).resolves.toEqual({ supported: false, update: null });
    await expect(getInstalledAppVersion()).resolves.toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("maps signed updater metadata and download progress", async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const update = {
      currentVersion: "0.2.0",
      version: "0.2.1",
      date: "2026-08-26T12:00:00.000Z",
      body: "Release notes",
      close: vi.fn().mockResolvedValue(undefined),
      downloadAndInstall: vi.fn(async (onProgress) => {
        onProgress({ event: "Started", data: { contentLength: 30 } });
        onProgress({ event: "Progress", data: { chunkLength: 12 } });
        onProgress({ event: "Finished" });
      }),
    };
    mocks.check.mockResolvedValue(update);
    const { checkForAppUpdate, downloadAndInstallAppUpdate, readPendingUpdateSmoke } =
      await import("./appUpdater");
    const progress = vi.fn();

    await expect(checkForAppUpdate()).resolves.toEqual({
      supported: true,
      update: {
        currentVersion: "0.2.0",
        version: "0.2.1",
        date: "2026-08-26T12:00:00.000Z",
        notes: "Release notes",
      },
    });
    await downloadAndInstallAppUpdate(progress);

    expect(mocks.check).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(progress).toHaveBeenLastCalledWith({
      downloadedBytes: 12,
      totalBytes: 30,
      finished: true,
    });
    expect(readPendingUpdateSmoke()).toMatchObject({
      fromVersion: "0.2.0",
      toVersion: "0.2.1",
    });
  });

  it("relaunches only when explicitly requested", async () => {
    const { restartApp } = await import("./appUpdater");
    expect(mocks.relaunch).not.toHaveBeenCalled();

    await restartApp();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
