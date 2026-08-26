import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const updater = vi.hoisted(() => ({
  appUpdaterSupported: vi.fn(),
  checkForAppUpdate: vi.fn(),
  downloadAndInstallAppUpdate: vi.fn(),
  getInstalledAppVersion: vi.fn(),
  restartApp: vi.fn(),
}));

vi.mock("../../state/appUpdater", () => updater);

import { AppUpdateSettings } from "./AppUpdateSettings";

beforeEach(() => {
  updater.appUpdaterSupported.mockReturnValue(true);
  updater.getInstalledAppVersion.mockResolvedValue("0.2.0");
  updater.checkForAppUpdate.mockResolvedValue({ supported: true, update: null });
  updater.downloadAndInstallAppUpdate.mockResolvedValue(undefined);
  updater.restartApp.mockResolvedValue(undefined);
});

describe("AppUpdateSettings", () => {
  it("is honest and non-operational in a browser", () => {
    updater.appUpdaterSupported.mockReturnValue(false);
    render(<AppUpdateSettings />);

    expect(screen.getByText(/available in the installed Glimmer desktop app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(updater.checkForAppUpdate).not.toHaveBeenCalled();
  });

  it("requires separate check, install and restart actions", async () => {
    updater.checkForAppUpdate.mockResolvedValue({
      supported: true,
      update: {
        currentVersion: "0.2.0",
        version: "0.2.1",
        date: "2026-08-26T12:00:00.000Z",
        notes: "A safer updater.",
      },
    });
    updater.downloadAndInstallAppUpdate.mockImplementation(async (onProgress) => {
      onProgress({ downloadedBytes: 512, totalBytes: 1024, finished: false });
      onProgress({ downloadedBytes: 1024, totalBytes: 1024, finished: true });
    });
    render(<AppUpdateSettings />);

    expect(await screen.findByText("Installed version: 0.2.0")).toBeInTheDocument();
    expect(updater.checkForAppUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(
      await screen.findByRole("heading", { name: "Version 0.2.1 is available" }),
    ).toBeInTheDocument();
    expect(screen.getByText("A safer updater.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    expect(await screen.findByRole("button", { name: "Restart Glimmer" })).toBeInTheDocument();
    expect(updater.restartApp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restart Glimmer" }));
    await waitFor(() => expect(updater.restartApp).toHaveBeenCalledOnce());
  });

  it("shows a recoverable check error", async () => {
    updater.checkForAppUpdate.mockRejectedValue(new Error("release endpoint unavailable"));
    render(<AppUpdateSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not check for updates — release endpoint unavailable",
    );
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });
});
