import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VisualVerificationPanel } from "./VisualVerificationPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("VisualVerificationPanel", () => {
  it('renders an honest "Not run" summary when the session never ran glimmer-visual.py (404)', async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue(null);
    render(withQuery(<VisualVerificationPanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getVisualVerification).toHaveBeenCalled());
    expect(await screen.findAllByText("Not run")).not.toHaveLength(0);
  });

  it("renders one thumbnail per (viewport, state) captured pair, linking to the screenshot endpoint", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/role-room",
        viewports: ["1440x900", "390x844"],
        states: ["initial", "dialogopen"],
        status: "pass",
        captures: [
          {
            viewport: "1440x900",
            state: "initial",
            screenshot: "1440x900-initial.png",
            status: "captured",
            error: null,
          },
          {
            viewport: "1440x900",
            state: "dialogopen",
            screenshot: "1440x900-dialogopen.png",
            status: "captured",
            error: null,
          },
          {
            viewport: "390x844",
            state: "initial",
            screenshot: "390x844-initial.png",
            status: "captured",
            error: null,
          },
          {
            viewport: "390x844",
            state: "dialogopen",
            screenshot: null,
            status: "failed",
            error: "click timed out",
          },
        ],
      },
      findings: null,
    });
    const { container } = render(withQuery(<VisualVerificationPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getAllByText("1440x900")).not.toHaveLength(0));

    // 3 captured pairs -> 3 <img> thumbnails, each linking to the real
    // screenshot endpoint for this session.
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(3);
    expect((images[0].closest("a") as HTMLAnchorElement).href).toContain(
      client.glimmerApi.visualScreenshotUrl("s1", "1440x900-initial.png"),
    );

    // The one failed capture shows a failure marker instead of a broken <img>.
    expect(screen.getByTitle("click timed out")).toBeInTheDocument();
  });

  it("renders findings with severity chips", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/role-room",
        viewports: ["1440x900"],
        states: ["initial"],
        status: "pass",
        captures: [
          { viewport: "1440x900", screenshot: "1440x900.png", status: "captured", error: null },
        ],
      },
      findings: {
        status: "FAIL",
        viewport: "multi",
        viewports: ["1440x900"],
        findings: [
          {
            id: "visual_001",
            severity: "critical",
            description: "Footer actions are clipped below viewport",
            viewport: "1440x900",
          },
          {
            id: "visual_002",
            severity: "low",
            description: "Slightly inconsistent padding",
            viewport: "1440x900",
          },
        ],
      },
    });
    render(withQuery(<VisualVerificationPanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText(/Footer actions are clipped/)).toBeInTheDocument());
    expect(screen.getByText(/Slightly inconsistent padding/)).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(screen.getByText("low")).toBeInTheDocument();
    // critical and low must not render with the same chip color.
    expect(screen.getByText("critical").getAttribute("style")).not.toEqual(
      screen.getByText("low").getAttribute("style"),
    );
  });
});
