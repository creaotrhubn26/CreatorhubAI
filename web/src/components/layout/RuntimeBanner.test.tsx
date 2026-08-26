import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauriGlobal: vi.fn(),
  runPostUpdateSmoke: vi.fn(),
}));

vi.mock("../../state/desktopNotify", () => ({ tauriGlobal: mocks.tauriGlobal }));
vi.mock("../../state/postUpdateSmoke", () => ({ runPostUpdateSmoke: mocks.runPostUpdateSmoke }));

import { RuntimeBanner } from "./RuntimeBanner";

beforeEach(() => {
  mocks.runPostUpdateSmoke.mockResolvedValue(null);
  mocks.tauriGlobal.mockReturnValue({
    core: {
      invoke: vi.fn().mockResolvedValue({
        state: "running",
        detail: "healthy",
        restartCount: 0,
      }),
    },
  });
});

describe("RuntimeBanner", () => {
  it("surfaces a native port conflict even when HTTP queries cannot reach the gateway", async () => {
    mocks.tauriGlobal.mockReturnValue({
      core: {
        invoke: vi.fn().mockResolvedValue({
          state: "port_conflict",
          detail: "Port 4317 is occupied by another service.",
          restartCount: 0,
        }),
      },
    });
    render(<RuntimeBanner />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Port 4317 is occupied");
  });

  it("shows a signed previous-release link when post-update smoke fails", async () => {
    mocks.runPostUpdateSmoke.mockResolvedValue({
      status: "failure",
      message: "Update 0.2.3 did not pass its startup test.",
      rollbackUrl: "https://github.com/creaotrhubn26/CreatorhubAI/releases/tag/v0.2.2",
    });
    render(<RuntimeBanner />);
    const link = await screen.findByRole("link", { name: "Previous signed release" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/creaotrhubn26/CreatorhubAI/releases/tag/v0.2.2",
    );
  });
});
