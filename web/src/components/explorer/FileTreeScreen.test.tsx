import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileTreeScreen } from "./FileTreeScreen";
import * as client from "../../api/client";

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function withProviders(ui: React.ReactElement, entry = "/files") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        {ui}
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const workspace = {
  path: "/w",
  branch: "glimmer/x",
  headSha: "abc",
  baselineSha: "abc",
  dirty: false,
  changedFiles: [],
};

const developerClients = {
  checkedAt: "2026-08-26T12:00:00.000Z",
  platform: "darwin arm64",
  clients: [
    {
      id: "vscode" as const,
      name: "Visual Studio Code",
      kind: "editor" as const,
      state: "app_only" as const,
      installed: true,
      workspaceHandoff: true,
      appPath: "/Applications/Visual Studio Code.app",
      executable: "code",
      detail: "Ready for workspace handoff.",
      mcp: {
        supported: true as const,
        setupMethod: "command_palette" as const,
        setupHint: "Open the MCP configuration.",
        docsUrl: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
      },
    },
    {
      id: "cursor" as const,
      name: "Cursor",
      kind: "editor" as const,
      state: "missing" as const,
      installed: false,
      workspaceHandoff: false,
      executable: "cursor",
      detail: "Missing.",
      mcp: {
        supported: true as const,
        setupMethod: "file" as const,
        setupHint: "Use mcp.json.",
        docsUrl: "https://cursor.com/docs/context/model-context-protocol",
      },
    },
  ],
  policy: {
    automaticInstall: false as const,
    automaticConfigWrites: false as const,
    credentialContentsInspected: false as const,
    agentNestingAllowed: false as const,
  },
};

// One directory listing per absolute path, so lazy expansion is observable.
const TREE: Record<string, { entries: { name: string; isDir: boolean }[] }> = {
  "/w": {
    entries: [
      { name: "src", isDir: true },
      { name: "README.md", isDir: false },
    ],
  },
  "/w/src": { entries: [{ name: "a.ts", isDir: false }] },
};

function mockListing() {
  return vi.spyOn(client.glimmerApi, "listDirectory").mockImplementation(async ({ path }) => {
    const hit = TREE[path ?? ""];
    if (!hit) throw new Error(`unexpected listing request for ${path}`);
    return { root: "/w", path: path!, parent: null, entries: hit.entries, truncated: false };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(client.glimmerApi, "getDeveloperClients").mockResolvedValue(developerClients);
});

describe("FileTreeScreen", () => {
  it("lists the workspace root and does not list a directory until it is expanded", async () => {
    const listing = mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    render(withProviders(<FileTreeScreen />));

    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledWith({ path: "/w", root: "/w", includeFiles: true });
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "src" }));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
    expect(listing).toHaveBeenCalledWith({ path: "/w/src", root: "/w", includeFiles: true });
  });

  it("opens a clicked file in the viewer", async () => {
    mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    const readFile = vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      path: "/w/README.md",
      size: 3,
      bytesReturned: 3,
      truncated: false,
      binary: false,
      content: "hi\n",
    });
    render(withProviders(<FileTreeScreen />));

    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({ path: "/w/README.md" }));
  });

  it("opens the exact workspace in a detected client only after a user click", async () => {
    mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    const openWorkspace = vi.spyOn(client.glimmerApi, "openWorkspace").mockResolvedValue({
      clientId: "vscode",
      workspace: "/w",
      opened: true,
      method: "application",
    });
    render(withProviders(<FileTreeScreen />));

    const button = await screen.findByRole("button", {
      name: "Open workspace in Visual Studio Code",
    });
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open workspace in Cursor" })).toBeNull();
    fireEvent.click(button);

    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith("vscode", "/w"));
    expect(await screen.findByRole("status")).toHaveTextContent("Opened in Visual Studio Code");
  });

  it("keeps a failed handoff recoverable and shows the gateway explanation", async () => {
    mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    vi.spyOn(client.glimmerApi, "openWorkspace").mockRejectedValue(
      new Error("Visual Studio Code was not found"),
    );
    render(withProviders(<FileTreeScreen />));

    fireEvent.click(
      await screen.findByRole("button", { name: "Open workspace in Visual Studio Code" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open in Visual Studio Code — Visual Studio Code was not found",
    );
    expect(
      screen.getByRole("button", { name: "Open workspace in Visual Studio Code" }),
    ).toBeEnabled();
  });

  it("stores a selected line range in the URL without dropping its session context", async () => {
    mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      path: "/w/README.md",
      size: 3,
      bytesReturned: 3,
      truncated: false,
      binary: false,
      content: "hi\n",
    });
    const { container } = render(
      withProviders(<FileTreeScreen />, "/files?path=%2Fw%2FREADME.md&session=s1"),
    );
    await waitFor(() => expect(container.querySelector(".code-view__text")).not.toBeNull());
    const text = container.querySelector<HTMLElement>(".code-view__text")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(container.querySelector(".code-view__body")!);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("start=1"));
    expect(screen.getByTestId("location")).toHaveTextContent("end=1");
    expect(screen.getByTestId("location")).toHaveTextContent("session=s1");
  });

  it("expands the branch that reveals a file handed to it in the URL, and opens it", async () => {
    const listing = mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    const readFile = vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      path: "/w/src/a.ts",
      size: 3,
      bytesReturned: 3,
      truncated: false,
      binary: false,
      content: "x\n",
    });
    render(withProviders(<FileTreeScreen />, "/files?path=%2Fw%2Fsrc%2Fa.ts&line=1"));

    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
    expect(listing).toHaveBeenCalledWith({ path: "/w/src", root: "/w", includeFiles: true });
    expect(readFile).toHaveBeenCalledWith({ path: "/w/src/a.ts" });
  });

  // Review M1: `?path=` comes straight from the URL, so a path in no known
  // workspace must be REFUSED, not rendered with a caveat. (The gateway
  // refuses it too — that is the boundary; this is the message in front of it,
  // and it must not even ask for the bytes.)
  it("refuses a path that is in no known workspace, and does not request it", async () => {
    mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    const readFile = vi.spyOn(client.glimmerApi, "readFile");
    render(
      withProviders(
        <FileTreeScreen />,
        "/files?path=%2FUsers%2Fu%2F.local%2Fshare%2Fopencode%2Fauth.json",
      ),
    );

    expect(
      await screen.findByText(/not inside any workspace Glimmer knows about/i),
    ).toBeInTheDocument();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reports a directory it could not list rather than showing an empty branch", async () => {
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    vi.spyOn(client.glimmerApi, "listDirectory").mockRejectedValue(new Error("permission denied"));
    render(withProviders(<FileTreeScreen />));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not list this directory — permission denied",
    );
  });

  it("says there is no workspace rather than showing an empty tree", async () => {
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([]);
    render(withProviders(<FileTreeScreen />));
    expect(await screen.findByText(/No workspace yet/)).toBeInTheDocument();
  });

  it("says Unavailable when the workspace list itself could not be fetched", async () => {
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockRejectedValue(new Error("boom"));
    render(withProviders(<FileTreeScreen />));
    expect(await screen.findByText(/Unavailable/)).toBeInTheDocument();
  });
});
