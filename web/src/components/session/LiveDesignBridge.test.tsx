import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveDesignElement, LiveDesignSourceCandidate } from "@glimmer/shared";
import { LiveDesignBridge } from "./LiveDesignBridge";
import { glimmerApi } from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>
  );
}

const element: LiveDesignElement = {
  selector: "#settings-title",
  tagName: "h1",
  text: "Settings",
  attributes: { id: "settings-title", class: "title" },
  styles: {
    color: "rgb(17, 34, 51)",
    backgroundColor: "rgb(255, 255, 255)",
    fontFamily: "Inter",
    fontSize: "32px",
    fontWeight: "700",
    lineHeight: "40px",
    padding: "8px",
    margin: "0px",
    gap: "normal",
    borderColor: "rgb(0, 0, 0)",
    borderWidth: "0px",
    borderRadius: "4px",
    opacity: "1",
    display: "block",
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "normal",
    alignContent: "normal",
    justifyContent: "normal",
    width: "300px",
    height: "50px",
    minWidth: "0px",
    maxWidth: "none",
    minHeight: "0px",
    maxHeight: "none",
    position: "static",
    top: "auto",
    right: "auto",
    bottom: "auto",
    left: "auto",
    zIndex: "auto",
    gridTemplateColumns: "none",
    gridTemplateRows: "none",
    gridAutoFlow: "row",
    gridColumn: "auto",
    gridRow: "auto",
    order: "0",
    flex: "0 1 auto",
    boxSizing: "content-box",
  },
  rect: { x: 100, y: 80, width: 300, height: 50, viewportWidth: 1200, viewportHeight: 800 },
  sourcePathHint: "src/App.tsx:3:10",
  tokens: [{ name: "--color-accent", value: "#112233", property: "color" }],
  framework: "react",
  componentName: "SettingsHeader",
  stableId: "settings-title",
  breadcrumbs: [
    { tagName: "body", selector: "body", label: "body" },
    { tagName: "h1", selector: "#settings-title", label: "settings-title" },
  ],
  styleSources: [
    {
      selector: ".title",
      source: "src/theme.css",
      specificity: "0,1,0",
      inherited: false,
      declarations: [{ property: "font-size", value: "32px", important: false }],
    },
    {
      selector: "element.style",
      source: "inline",
      specificity: "1,0,0",
      inherited: false,
      declarations: [{ property: "color", value: "rgb(17, 34, 51)", important: false }],
    },
  ],
};

const candidate: LiveDesignSourceCandidate = {
  id: "a".repeat(64),
  path: "src/App.tsx",
  line: 3,
  column: 32,
  offset: 70,
  kind: "text-node",
  expected: "Settings",
  fileHash: "b".repeat(64),
  excerpt: '<h1 id="settings-title">Settings</h1>',
};

const styleCandidate: LiveDesignSourceCandidate = {
  id: "c".repeat(64),
  path: "src/theme.css",
  line: 4,
  column: 3,
  offset: 90,
  kind: "css-declaration",
  property: "font-size",
  expected: "32px",
  fileHash: "d".repeat(64),
  excerpt: ".title { font-size: 32px; }",
  confidence: "exact",
};

function emptyWorkflow(sessionId = "s1") {
  return {
    version: 1 as const,
    revision: 0,
    sessionId,
    updatedAt: "1970-01-01T00:00:00.000Z",
    changeSets: [],
  };
}

describe("LiveDesignBridge", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(glimmerApi, "getLiveDesignDraft").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "saveLiveDesignDraft").mockImplementation(async (sessionId, update) => ({
      version: 1 as const,
      sessionId,
      updatedAt: "2026-08-27T12:00:00.000Z",
      ...update,
    }));
    vi.spyOn(glimmerApi, "clearLiveDesignDraft").mockResolvedValue({ cleared: true });
  });

  it("replays the immediate local mirror through server validation after an abrupt exit", async () => {
    window.localStorage.setItem(
      "glimmer.live-design-draft.s1",
      JSON.stringify({
        version: 1,
        sessionId: "s1",
        route: "http://localhost:4173/settings",
        updatedAt: "2026-08-27T12:00:00.000Z",
        sequence: 4,
        selectedSelectors: [],
        lockedSelectors: [],
        hiddenSelectors: [],
        activeTab: "responsive",
        viewportId: "mobile",
        zoom: 90,
        inspectorWidth: 380,
        elementPrompt: "Keep this fluid",
        annotationComment: "",
        annotationTool: "comment",
        annotationPoints: [],
        assetPrompt: "Generate a quiet abstract background",
        assetPath: "public/generated/background.png",
        responsiveBreakpoint: "mobile",
        responsiveProperty: "font-size",
        responsiveValue: "24px",
        responsiveOverrides: { "mobile:font-size": "24px" },
        styleScope: "component",
      }),
    );
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());

    render(withQuery(<LiveDesignBridge sessionId="s1" route="http://localhost:4173/settings" />));

    expect(await screen.findByText("Breakpoint override")).toBeVisible();
    expect(glimmerApi.saveLiveDesignDraft).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        sequence: 4,
        activeTab: "responsive",
        assetPrompt: "Generate a quiet abstract background",
      }),
    );
    expect(screen.getByText(/Recovered unsaved Live Design progress/)).toBeVisible();
  });

  it("supports canvas-first preview, shortcut help, and keyboard tools", async () => {
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());
    vi.spyOn(glimmerApi, "resolveLiveDesignElement").mockResolvedValue({
      candidates: [candidate, styleCandidate],
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      scannedFiles: 2,
      truncated: false,
    });

    const { container } = render(
      withQuery(<LiveDesignBridge sessionId="s1" route="http://localhost:4173/settings" />),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const init = postMessage.mock.calls.find((call) => (call[0] as any).type === "init")?.[0] as {
      channel: string;
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "ready",
          },
        }),
      );
    });
    expect(await screen.findByText("Connected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Live Design keyboard shortcuts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close shortcuts" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(container.querySelector(".live-design-bridge")).toHaveClass(
      "live-design-bridge--preview",
    );
    expect(container.querySelector(".live-design-bridge__inspector")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Exit preview" }));

    const root = container.querySelector(".live-design-bridge") as HTMLElement;
    fireEvent.pointerEnter(root);
    fireEvent.keyDown(window, { key: "v" });
    expect(postMessage.mock.calls.some((call) => (call[0] as any).type === "select")).toBe(true);
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByRole("button", { name: "1280" })).toHaveAttribute("aria-pressed", "true");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "structure",
            roots: [
              {
                selector: "body",
                tagName: "body",
                label: "body",
                text: "",
                attributes: {},
                canHaveChildren: true,
                hidden: false,
                children: [
                  {
                    selector: "#settings-title",
                    tagName: "h1",
                    label: "settings-title",
                    text: "Settings",
                    attributes: { id: "settings-title", class: "title" },
                    canHaveChildren: true,
                    hidden: false,
                    children: [],
                  },
                ],
              },
            ],
            total: 2,
            truncated: false,
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selected",
            element,
          },
        }),
      );
    });
    await waitFor(() => expect(glimmerApi.resolveLiveDesignElement).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selection-many",
            elements: [
              element,
              {
                ...element,
                selector: 'p[data-testid="description"]',
                tagName: "p",
                text: "Manage your workspace",
                attributes: { "data-testid": "description" },
                componentName: "SettingsDescription",
              },
            ],
          },
        }),
      );
    });
    expect(await screen.findByText("2 selected")).toBeVisible();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(
      postMessage.mock.calls.some(
        (call) =>
          (call[0] as any).type === "describe-selector" && (call[0] as any).selector === "body",
      ),
    ).toBe(true);
  });

  it("handshakes with the local frame, previews a selection, writes source, and rolls back", async () => {
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());
    const resolve = vi.spyOn(glimmerApi, "resolveLiveDesignElement").mockResolvedValue({
      candidates: [candidate],
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      scannedFiles: 2,
      truncated: false,
    });
    const apply = vi.spyOn(glimmerApi, "applyLiveDesignEdit").mockResolvedValue({
      applied: true,
      revision: {
        id: "revision-1",
        path: "src/App.tsx",
        kind: "text-node",
        before: "Settings",
        after: "Workspace settings",
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    });
    const rollback = vi.spyOn(glimmerApi, "rollbackLiveDesignEdit").mockResolvedValue({
      rolledBack: true,
      revision: {
        id: "revision-1",
        path: "src/App.tsx",
        kind: "text-node",
        before: "Settings",
        after: "Workspace settings",
        createdAt: "2026-08-27T12:00:00.000Z",
        rolledBackAt: "2026-08-27T12:01:00.000Z",
      },
    });

    const { container } = render(
      withQuery(
        <LiveDesignBridge
          sessionId="s1"
          route="http://localhost:4173/settings"
          capture={{
            viewport: "1200x800",
            state: "initial",
            screenshot: "settings.png",
            status: "captured",
            error: null,
          }}
        />,
      ),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const init = postMessage.mock.calls.find((call) => (call[0] as any).type === "init")?.[0] as {
      channel: string;
    };
    expect(init.channel).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "ready",
          },
        }),
      );
    });
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select element" }));
    expect(postMessage.mock.calls.some((call) => (call[0] as any).type === "select")).toBe(true);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selected",
            element,
          },
        }),
      );
    });
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("s1", { element }));
    expect(await screen.findByText("SettingsHeader")).toBeInTheDocument();
    expect(await screen.findByText("src/App.tsx:3:10")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Workspace settings" },
    });
    await waitFor(() =>
      expect(
        postMessage.mock.calls.some(
          (call) =>
            (call[0] as any).type === "preview" &&
            (call[0] as any).patch.text === "Workspace settings",
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save text to source" }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith("s1", {
        candidate,
        replacement: "Workspace settings",
      }),
    );
    expect(await screen.findByText(/Saved src\/App.tsx to disk/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo last source edit" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("s1", "revision-1"));
    expect(await screen.findByText(/Rolled back src\/App.tsx/)).toBeInTheDocument();
  });

  it("saves an atomic style binding and keeps annotations and variants in one workflow", async () => {
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());
    vi.spyOn(glimmerApi, "resolveLiveDesignElement").mockResolvedValue({
      candidates: [candidate, styleCandidate],
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      scannedFiles: 2,
      truncated: false,
      auditFindings: [],
      tokenGraph: [],
      cmsReferences: [],
    });
    const transaction = vi.spyOn(glimmerApi, "applyLiveDesignTransaction").mockResolvedValue({
      applied: true,
      revision: {
        id: "revision-style",
        path: "src/theme.css",
        kind: "transaction",
        before: "",
        after: "",
        changeCount: 1,
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    });
    const saveFeedback = vi
      .spyOn(glimmerApi, "saveDesignFeedback")
      .mockImplementation(async (_sessionId, update) => ({
        version: 1,
        sessionId: "s1",
        updatedAt: "2026-08-27T12:00:00.000Z",
        ...update,
      }));
    vi.spyOn(glimmerApi, "proposeLiveDesignChange").mockResolvedValue({
      id: "proposal-1",
      prompt: "Give this heading stronger hierarchy",
      summary: "Strengthen the selected heading hierarchy.",
      provenance: "model-output",
      createdAt: "2026-08-27T12:00:00.000Z",
      changes: [
        {
          field: "fontSizePx",
          label: "Font size",
          before: "32",
          after: "36",
          reason: "Creates a clearer heading hierarchy.",
        },
      ],
    });

    const { container } = render(
      withQuery(
        <LiveDesignBridge
          sessionId="s1"
          route="http://localhost:4173/settings"
          capture={{
            viewport: "1200x800",
            state: "initial",
            screenshot: "settings.png",
            status: "captured",
            error: null,
          }}
        />,
      ),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const init = postMessage.mock.calls.find((call) => (call[0] as any).type === "init")?.[0] as {
      channel: string;
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "ready",
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selected",
            element,
          },
        }),
      );
    });

    fireEvent.change(screen.getByLabelText("Ask Glimmer about this element"), {
      target: { value: "Give this heading stronger hierarchy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    expect(await screen.findByText("Strengthen the selected heading hierarchy.")).toBeVisible();
    expect(screen.getByText("36")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Accept and queue" }));
    await waitFor(() =>
      expect(saveFeedback).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          annotations: [
            expect.objectContaining({
              comment: "Give this heading stronger hierarchy",
              selectorHint: "#settings-title",
              sourcePathHint: expect.stringContaining("src/App.tsx"),
              tool: "comment",
            }),
          ],
        }),
      ),
    );

    fireEvent.click(await screen.findByRole("tab", { name: "Style" }));
    expect(screen.getByText("Property sources")).toBeVisible();
    expect(screen.getAllByText("src/theme.css").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Font px"), { target: { value: "36" } });
    fireEvent.change(screen.getByLabelText("Text color"), { target: { value: "#ffffff" } });
    fireEvent.change(screen.getByLabelText("Background"), { target: { value: "#ffffff" } });
    expect(await screen.findByRole("button", { name: "Save 1 style to source" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(await screen.findByText(/Preview contrast is 1\.00:1/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fix preview" }));
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 style to source" }));
    await waitFor(() =>
      expect(transaction).toHaveBeenCalledWith("s1", {
        edits: [{ candidate: styleCandidate, replacement: "36px" }],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.click(screen.getByRole("button", { name: "Draw design feedback" }), {
      clientX: 1,
      clientY: 1,
    });
    fireEvent.change(screen.getByLabelText("Design note"), {
      target: { value: "Align this with the grid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note for Glimmer" }));
    await waitFor(() =>
      expect(saveFeedback).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          annotations: expect.arrayContaining([
            expect.objectContaining({
              comment: "Align this with the grid",
              selectorHint: "#settings-title",
            }),
          ]),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Variants" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate all 3 with Glimmer" }));
    await waitFor(() => {
      const lastUpdate = saveFeedback.mock.calls.at(-1)?.[1];
      expect(lastUpdate?.annotations).toHaveLength(2);
      expect(lastUpdate?.variants).toEqual([
        expect.objectContaining({ count: 3, target: "SettingsHeader" }),
      ]);
    });
  });

  it("loads the navigator, stages a semantic insert, and saves it through Structure Mode", async () => {
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());
    vi.spyOn(glimmerApi, "resolveLiveDesignElement").mockResolvedValue({
      candidates: [candidate, styleCandidate],
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      scannedFiles: 2,
      truncated: false,
    });
    const applyStructure = vi.spyOn(glimmerApi, "applyLiveDesignStructure").mockResolvedValue({
      applied: true,
      revision: {
        id: "revision-structure",
        path: "src/App.tsx",
        kind: "structure-insert",
        before: "No inserted paragraph",
        after: "Inserted paragraph",
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    });

    const { container } = render(
      withQuery(<LiveDesignBridge sessionId="s1" route="http://localhost:4173/settings" />),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const init = postMessage.mock.calls.find((call) => (call[0] as any).type === "init")?.[0] as {
      channel: string;
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "ready",
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "structure",
            total: 4,
            truncated: false,
            roots: [
              {
                selector: "body",
                tagName: "body",
                label: "body",
                text: "Settings Manage your workspace",
                attributes: {},
                framework: "unknown",
                canHaveChildren: true,
                hidden: false,
                children: [
                  {
                    selector: "main",
                    tagName: "main",
                    label: "main",
                    text: "Settings Manage your workspace",
                    attributes: {},
                    framework: "react",
                    canHaveChildren: true,
                    hidden: false,
                    children: [
                      {
                        selector: "#settings-title",
                        tagName: "h1",
                        label: "settings-title",
                        text: "Settings",
                        attributes: { id: "settings-title", class: "title" },
                        sourcePathHint: "src/App.tsx",
                        framework: "react",
                        componentName: "SettingsHeader",
                        canHaveChildren: true,
                        hidden: false,
                        children: [],
                      },
                      {
                        selector: "main > p",
                        tagName: "p",
                        label: "Manage your workspace",
                        text: "Manage your workspace",
                        attributes: { "data-testid": "description" },
                        sourcePathHint: "src/App.tsx",
                        framework: "react",
                        canHaveChildren: true,
                        hidden: false,
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selected",
            element,
          },
        }),
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: "Structure mode" }));
    expect(await screen.findByText("4 DOM elements")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select settings-title" })).toHaveClass(
      "is-selected",
    );
    fireEvent.change(screen.getByLabelText("Element"), { target: { value: "paragraph" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "after" } });
    fireEvent.change(screen.getByLabelText("Starter text"), {
      target: { value: "Invite your team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview insert" }));
    await waitFor(() =>
      expect(
        postMessage.mock.calls.some(
          (call) =>
            (call[0] as any).type === "preview-structure" &&
            (call[0] as any).operation.text === "Invite your team",
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save structure to source" }));
    await waitFor(() =>
      expect(applyStructure).toHaveBeenCalledWith("s1", {
        kind: "insert",
        target: {
          selector: "#settings-title",
          tagName: "h1",
          text: "Settings",
          attributes: { id: "settings-title", class: "title" },
          sourcePathHint: "src/App.tsx",
          framework: "react",
          componentName: "SettingsHeader",
        },
        placement: "after",
        preset: "paragraph",
        text: "Invite your team",
      }),
    );
    expect(await screen.findByText(/Saved the staged structure/)).toBeInTheDocument();
  });

  it("previews and saves a breakpoint-specific stylesheet override", async () => {
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());
    vi.spyOn(glimmerApi, "resolveLiveDesignElement").mockResolvedValue({
      candidates: [candidate, styleCandidate],
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      scannedFiles: 2,
      truncated: false,
    });
    const applyResponsive = vi
      .spyOn(glimmerApi, "applyLiveDesignResponsiveOverride")
      .mockResolvedValue({
        applied: true,
        revision: {
          id: "revision-responsive",
          path: "src/theme.css",
          kind: "responsive-override",
          before: "font-size before mobile override",
          after: "font-size: 24px at mobile",
          createdAt: "2026-08-27T12:00:00.000Z",
        },
      });

    const { container } = render(
      withQuery(<LiveDesignBridge sessionId="s1" route="http://localhost:4173/settings" />),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const init = postMessage.mock.calls.find((call) => (call[0] as any).type === "init")?.[0] as {
      channel: string;
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "ready",
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selected",
            element,
          },
        }),
      );
    });
    await waitFor(() => expect(glimmerApi.resolveLiveDesignElement).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Responsive" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "24px" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview at mobile" }));
    expect(
      postMessage.mock.calls.some(
        (call) =>
          (call[0] as any).type === "preview-responsive" &&
          (call[0] as any).override.value === "24px",
      ),
    ).toBe(true);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "responsive-preview-applied",
          },
        }),
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save override to source" }));
    await waitFor(() =>
      expect(applyResponsive).toHaveBeenCalledWith("s1", {
        element,
        source: styleCandidate,
        breakpoint: "mobile",
        property: "font-size",
        value: "24px",
      }),
    );
    expect(await screen.findByText(/Saved the mobile override/)).toBeInTheDocument();
  });

  it("captures resize handles and saves Grid layout for all matching component instances", async () => {
    vi.spyOn(glimmerApi, "getDesignFeedback").mockResolvedValue(null);
    vi.spyOn(glimmerApi, "getLiveDesignHistory").mockResolvedValue({ revisions: [] });
    vi.spyOn(glimmerApi, "getDesignWorkflow").mockResolvedValue(emptyWorkflow());
    vi.spyOn(glimmerApi, "resolveLiveDesignElement").mockResolvedValue({
      candidates: [candidate, styleCandidate],
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      scannedFiles: 2,
      truncated: false,
    });
    const applyStyle = vi.spyOn(glimmerApi, "applyLiveDesignStyleOverride").mockResolvedValue({
      applied: true,
      selector: ".title",
      revision: {
        id: "revision-layout",
        path: "src/theme.css",
        kind: "style-override",
        before: "component layout before override",
        after: "5 component layout declarations",
        changeCount: 5,
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    });

    const { container } = render(
      withQuery(<LiveDesignBridge sessionId="s1" route="http://localhost:4173/settings" />),
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const init = postMessage.mock.calls.find((call) => (call[0] as any).type === "init")?.[0] as {
      channel: string;
    };
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "ready",
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "selected",
            element,
          },
        }),
      );
    });
    await waitFor(() => expect(glimmerApi.resolveLiveDesignElement).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Transform handles" }));
    expect(
      postMessage.mock.calls.some(
        (call) => (call[0] as any).type === "enable-resize" && (call[0] as any).enabled === true,
      ),
    ).toBe(true);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "resize-change",
            selector: "#settings-title",
            width: "360px",
            height: "80px",
            boxSizing: "border-box",
          },
        }),
      );
    });
    expect(screen.getByLabelText("Width")).toHaveValue("360px");
    expect(screen.getByLabelText("Height")).toHaveValue("80px");
    fireEvent.change(screen.getByLabelText("Layout display"), { target: { value: "grid" } });
    fireEvent.change(screen.getByLabelText("Grid columns"), {
      target: { value: "repeat(2, minmax(0, 1fr))" },
    });
    await waitFor(() =>
      expect(
        postMessage.mock.calls.some(
          (call) =>
            (call[0] as any).type === "preview-style-rule" &&
            (call[0] as any).rule.selector === ".title",
        ),
      ).toBe(true),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "http://localhost:4173",
          data: {
            namespace: "glimmer-live-design",
            channel: init.channel,
            type: "style-rule-preview-applied",
          },
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Save layout to source" }));
    await waitFor(() =>
      expect(applyStyle).toHaveBeenCalledWith("s1", {
        element,
        source: styleCandidate,
        scope: "component",
        className: "title",
        declarations: {
          display: "grid",
          width: "360px",
          height: "80px",
          "grid-template-columns": "repeat(2, minmax(0, 1fr))",
          "box-sizing": "border-box",
        },
      }),
    );
    expect(await screen.findByText(/Saved 5 layout rules for \.title/)).toBeInTheDocument();
  });
});
