import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CodeViewer } from "./CodeViewer";
import * as client from "../../api/client";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const textFile = {
  path: "/w/src/a.ts",
  size: 26,
  bytesReturned: 26,
  truncated: false,
  binary: false,
  content: "const x = 1;\nconst y = 2;\n",
};

beforeEach(() => {
  vi.restoreAllMocks();
  // jsdom has no layout, so scrollIntoView is undefined on the element.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("CodeViewer", () => {
  it("renders numbered lines with the shared tokenizer's tok-* spans", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue(textFile);
    const { container } = render(withQuery(<CodeViewer path="/w/src/a.ts" />));

    await waitFor(() => expect(screen.getAllByText("const", { selector: ".tok-keyword" }).length).toBe(2));
    const lines = container.querySelectorAll(".code-view__line");
    expect(lines).toHaveLength(2); // trailing newline is not a third line
    expect(lines[0].querySelector(".code-view__lineno")?.textContent).toBe("1");
    // The highlighting is the diff screen's, not a second implementation.
    expect(container.querySelectorAll(".tok-keyword").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".tok-number").length).toBeGreaterThan(0);
  });

  it("marks the requested line", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue(textFile);
    const { container } = render(withQuery(<CodeViewer path="/w/src/a.ts" line={2} />));
    await waitFor(() => expect(container.querySelector(".code-view__line.is-current")).not.toBeNull());
    expect(container.querySelector(".code-view__line.is-current")?.getAttribute("data-line")).toBe("2");
  });

  it("says so when the requested line is past what was read, instead of silently landing at the top", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue(textFile);
    const { container } = render(withQuery(<CodeViewer path="/w/src/a.ts" line={900} />));
    expect(await screen.findByText(/Line 900 is past the 2 lines/)).toBeInTheDocument();
    expect(container.querySelector(".code-view__line.is-current")).toBeNull();
  });

  it("shows a truncation notice above AND below, so the excerpt's end can't read as the file's end", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      ...textFile,
      size: 900000,
      bytesReturned: 524288,
      truncated: true,
    });
    render(withQuery(<CodeViewer path="/w/src/a.ts" />));
    expect(await screen.findByText(/showing the first 524,288 of 900,000 bytes/i)).toBeInTheDocument();
    expect(screen.getByText(/not the end of the file/i)).toBeInTheDocument();
  });

  it("shows a binary notice and no content at all", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      path: "/w/logo.png", size: 4096, bytesReturned: 0, truncated: false, binary: true, content: null,
    });
    const { container } = render(withQuery(<CodeViewer path="/w/logo.png" />));
    expect(await screen.findByText(/Binary file — not shown \(4,096 bytes on disk\)/)).toBeInTheDocument();
    expect(container.querySelectorAll(".code-view__line")).toHaveLength(0);
  });

  it("surfaces the gateway's own reason for a failed read — never an empty document", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockRejectedValue(new Error("permission denied"));
    const { container } = render(withQuery(<CodeViewer path="/w/secret" />));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not read this file — permission denied");
    expect(container.querySelectorAll(".code-view__line")).toHaveLength(0);
  });

  it("says a directory is a directory rather than showing it as a file", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockRejectedValue(new Error("path is a directory"));
    render(withQuery(<CodeViewer path="/w/src" />));
    expect(await screen.findByRole("alert")).toHaveTextContent("path is a directory");
  });

  it("says a vanished file is gone rather than rendering it empty", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockRejectedValue(new Error("path does not exist"));
    render(withQuery(<CodeViewer path="/w/gone.ts" />));
    expect(await screen.findByRole("alert")).toHaveTextContent("path does not exist");
  });

  it("names an empty file as empty", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue({
      path: "/w/empty.txt", size: 0, bytesReturned: 0, truncated: false, binary: false, content: "",
    });
    render(withQuery(<CodeViewer path="/w/empty.txt" />));
    expect(await screen.findByText("This file is empty (0 bytes).")).toBeInTheDocument();
  });

  it("offers no way to edit — it is a viewer", async () => {
    vi.spyOn(client.glimmerApi, "readFile").mockResolvedValue(textFile);
    const { container } = render(withQuery(<CodeViewer path="/w/src/a.ts" />));
    await waitFor(() => expect(screen.getAllByText("const", { selector: ".tok-keyword" })).toHaveLength(2));
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });
});
