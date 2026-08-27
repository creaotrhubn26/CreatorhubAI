import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { VisualVerificationPanel } from "./VisualVerificationPanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
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

  it("shows whether each reference stayed local or was reviewed by the selected Vision model", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/settings",
        viewports: ["1440x900"],
        states: ["initial"],
        status: "pass",
        captures: [],
      },
      findings: {
        status: "PASS",
        viewport: "multi",
        viewports: ["1440x900"],
        findings: [],
        modelId: "vision-model-1",
        referenceImagePolicy: "vision-model",
        referencesSentToModel: ["reference-01.png"],
        referencesReviewedByModel: ["reference-01.png"],
        references: [
          {
            file: "reference-01.png",
            label: "Settings reference",
            sourcePath: "design/settings.png",
            modelReviewed: true,
          },
        ],
      },
    });
    render(withQuery(<VisualVerificationPanel sessionId="s1" />));

    expect(await screen.findByText(/Compared by Vision \(vision-model-1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Settings reference · Vision \+ human/)).toBeInTheDocument();
    const image = screen.getByAltText("Settings reference") as HTMLImageElement;
    expect(image.src).toContain(client.glimmerApi.visualReferenceUrl("s1", "reference-01.png"));
  });

  it("does not claim a consented reference was reviewed when the Vision call was blocked", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/settings",
        viewports: ["1440x900"],
        states: ["initial"],
        status: "pass",
        captures: [],
      },
      findings: {
        status: "BLOCKED",
        viewport: "multi",
        viewports: ["1440x900"],
        findings: [],
        modelId: "vision-model-1",
        referenceImagePolicy: "vision-model",
        referencesSentToModel: ["reference-01.png"],
        referencesReviewedByModel: [],
        references: [{ file: "reference-01.png", label: "Settings", modelReviewed: false }],
      },
    });
    render(withQuery(<VisualVerificationPanel sessionId="s1" />));

    expect(await screen.findByText(/no comparison completed/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings · human only/)).toBeInTheDocument();
    expect(screen.queryByText(/Settings · Vision \+ human/)).not.toBeInTheDocument();
  });

  it("persists a click annotation as normalized, structured feedback", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/settings",
        viewports: ["1440x900"],
        states: ["initial"],
        status: "pass",
        captures: [
          {
            viewport: "1440x900",
            state: "initial",
            screenshot: "1440x900-initial.png",
            status: "captured",
            error: null,
          },
        ],
      },
      findings: null,
    });
    vi.spyOn(client.glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    const save = vi
      .spyOn(client.glimmerApi, "saveDesignFeedback")
      .mockImplementation(async (sessionId, update) => ({
        version: 1,
        sessionId,
        updatedAt: "2026-08-27T10:00:00.000Z",
        ...update,
      }));
    const { container } = render(
      withQuery(<VisualVerificationPanel sessionId="s1" workspace="/tmp/ws" />),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Visual Verification/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Annotate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw" }));
    fireEvent.change(screen.getByLabelText("Tool"), { target: { value: "comment" } });
    const layer = await screen.findByLabelText("Clickable visual annotation layer");
    Object.defineProperty(layer, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    });
    Object.defineProperty(layer, "setPointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 250, clientY: 125 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    fireEvent.change(screen.getByPlaceholderText("What should Glimmer change here?"), {
      target: { value: "Increase contrast using the semantic accent token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save markup" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1].annotations[0]).toMatchObject({
      screenshot: "1440x900-initial.png",
      tool: "comment",
      points: [{ x: 0.25, y: 0.25 }],
      comment: "Increase contrast using the semantic accent token",
    });
    expect(container.querySelector(".visual-feedback-studio")).toBeInTheDocument();
  });

  it("persists element edits and project-referenced asset jobs for Glimmer handoff", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/settings",
        viewports: ["1440x900"],
        states: ["initial"],
        status: "pass",
        captures: [
          {
            viewport: "1440x900",
            state: "initial",
            screenshot: "1440x900-initial.png",
            status: "captured",
            error: null,
          },
        ],
      },
      findings: null,
    });
    vi.spyOn(client.glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    const save = vi
      .spyOn(client.glimmerApi, "saveDesignFeedback")
      .mockImplementation(async (sessionId, update) => ({
        version: 1,
        sessionId,
        updatedAt: "2026-08-27T10:00:00.000Z",
        ...update,
      }));
    render(
      withQuery(
        <VisualVerificationPanel
          sessionId="s1"
          workspace="/tmp/ws"
          initialReferenceImages={[{ path: "design/brand.png", label: "Brand palette" }]}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Visual Verification/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Annotate" }));
    const layer = await screen.findByLabelText("Clickable visual annotation layer");
    Object.defineProperty(layer, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    });
    Object.defineProperty(layer, "setPointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    fireEvent.change(screen.getByLabelText("Element name"), {
      target: { value: "Settings title" },
    });
    fireEvent.click(screen.getByLabelText("Change text"));
    fireEvent.change(screen.getByLabelText("New text"), {
      target: { value: "Workspace settings" },
    });
    fireEvent.change(screen.getByLabelText("Background"), { target: { value: "#112233" } });
    fireEvent.click(screen.getByRole("button", { name: "Save element edit" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1].elementEdits[0]).toMatchObject({
      target: "Settings title",
      text: "Workspace settings",
      region: { x: 0.1, y: 0.2 },
      style: { backgroundColor: "#112233" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Editorial settings illustration using the brand palette" },
    });
    fireEvent.change(screen.getByLabelText("Output path"), {
      target: { value: "public/generated/settings.webp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save generation request" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][1].assetRequests[0]).toMatchObject({
      kind: "image",
      outputPath: "public/generated/settings.webp",
      size: "2K",
      referenceImages: [{ path: "design/brand.png", label: "Brand palette" }],
      referenceUploadPolicy: "local-only",
    });
  });

  it("keeps an annotation draft visible when disk persistence fails", async () => {
    vi.spyOn(client.glimmerApi, "getVisualVerification").mockResolvedValue({
      manifest: {
        route: "http://localhost:5183/settings",
        viewports: ["1440x900"],
        states: ["initial"],
        status: "pass",
        captures: [
          {
            viewport: "1440x900",
            state: "initial",
            screenshot: "1440x900-initial.png",
            status: "captured",
            error: null,
          },
        ],
      },
      findings: null,
    });
    vi.spyOn(client.glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(client.glimmerApi, "saveDesignFeedback").mockRejectedValue(new Error("disk full"));
    const { container } = render(
      withQuery(<VisualVerificationPanel sessionId="s1" workspace="/tmp/ws" />),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Visual Verification/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Annotate" }));
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    fireEvent.change(screen.getByLabelText("Tool"), { target: { value: "comment" } });
    const layer = await screen.findByLabelText("Clickable visual annotation layer");
    Object.defineProperty(layer, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    });
    Object.defineProperty(layer, "setPointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 250, clientY: 125 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    const instruction = screen.getByPlaceholderText("What should Glimmer change here?");
    fireEvent.change(instruction, { target: { value: "Keep this draft until it is durable" } });
    fireEvent.click(screen.getByRole("button", { name: "Save markup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/disk full/i);
    expect(instruction).toHaveValue("Keep this draft until it is durable");
    expect(container.querySelector(".visual-feedback-studio__items li")).not.toBeInTheDocument();
  });
});
