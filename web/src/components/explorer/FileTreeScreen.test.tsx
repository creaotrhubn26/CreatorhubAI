import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileTreeScreen } from "./FileTreeScreen";
import * as client from "../../api/client";

function withProviders(ui: React.ReactElement, entry = "/files") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>
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

// One directory listing per absolute path, so lazy expansion is observable.
const TREE: Record<string, { entries: { name: string; isDir: boolean }[] }> = {
  "/w": { entries: [{ name: "src", isDir: true }, { name: "README.md", isDir: false }] },
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
      path: "/w/README.md", size: 3, bytesReturned: 3, truncated: false, binary: false, content: "hi\n",
    });
    render(withProviders(<FileTreeScreen />));

    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({ path: "/w/README.md" }));
  });

  it("expands the branch that reveals a file handed to it in the URL, and opens it", async () => {
    const listing = mockListing();
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    const readFile = vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      path: "/w/src/a.ts", size: 3, bytesReturned: 3, truncated: false, binary: false, content: "x\n",
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
    render(withProviders(<FileTreeScreen />, "/files?path=%2FUsers%2Fu%2F.local%2Fshare%2Fopencode%2Fauth.json"));

    expect(await screen.findByText(/not inside any workspace Glimmer knows about/i)).toBeInTheDocument();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reports a directory it could not list rather than showing an empty branch", async () => {
    vi.spyOn(client.glimmerApi, "listWorkspaces").mockResolvedValue([workspace]);
    vi.spyOn(client.glimmerApi, "listDirectory").mockRejectedValue(new Error("permission denied"));
    render(withProviders(<FileTreeScreen />));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not list this directory — permission denied");
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
