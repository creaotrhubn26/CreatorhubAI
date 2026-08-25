import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PathPicker } from "./PathPicker";
import * as client from "../../api/client";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

// jsdom has no window.__TAURI__, so every case here exercises the browser
// fallback (the gateway's read-only directory browser) — which is exactly the
// path a security review cares about.
describe("PathPicker (browser fallback)", () => {
  const listing = {
    root: "/home/u",
    path: "/home/u/project",
    parent: "/home/u",
    entries: [
      { name: "src", isDir: true },
      { name: "README.md", isDir: false },
    ],
    truncated: false,
  };

  it("browses into a directory and hands back the absolute path chosen", async () => {
    const spy = vi.spyOn(client.glimmerApi, "listDirectory").mockResolvedValue(listing);
    const onPick = vi.fn();
    render(withQuery(<PathPicker mode="directory" root="/home/u" onPick={onPick} />));

    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "src/" })).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith({ path: "/home/u", root: "/home/u", includeFiles: false });

    fireEvent.click(screen.getByRole("button", { name: "Use this directory" }));
    expect(onPick).toHaveBeenCalledWith(["/home/u/project"]);
  });

  it("navigates into subdirectories and never above the root (no parent link at the root)", async () => {
    const spy = vi
      .spyOn(client.glimmerApi, "listDirectory")
      .mockResolvedValue({ ...listing, parent: null });
    render(withQuery(<PathPicker mode="directory" root="/home/u" onPick={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "src/" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "../" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "src/" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        path: "/home/u/project/src",
        root: "/home/u",
        includeFiles: false,
      }),
    );
  });

  it("multi-selects files and returns every checked path", async () => {
    vi.spyOn(client.glimmerApi, "listDirectory").mockResolvedValue(listing);
    const onPick = vi.fn();
    render(withQuery(<PathPicker mode="files" root="/home/u" onPick={onPick} />));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => expect(screen.getByLabelText("README.md")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Use 0 selected files/ })).toBeDisabled();

    fireEvent.click(screen.getByLabelText("README.md"));
    fireEvent.click(screen.getByRole("button", { name: /Use 1 selected file/ }));
    expect(onPick).toHaveBeenCalledWith(["/home/u/project/README.md"]);
  });

  it("surfaces the server's refusal instead of silently showing an empty directory", async () => {
    vi.spyOn(client.glimmerApi, "listDirectory").mockRejectedValue(
      new Error("GET /api/fs/dirs failed: 403"),
    );
    render(withQuery(<PathPicker mode="directory" root="/home/u" onPick={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("403");
  });

  it("stays disabled, with a reason, when the caller has nothing to root it at", () => {
    render(
      withQuery(
        <PathPicker mode="directory" disabledReason="Choose a workspace first." onPick={vi.fn()} />,
      ),
    );
    expect(screen.getByRole("button", { name: "Browse…" })).toBeDisabled();
    expect(screen.getByText("Choose a workspace first.")).toBeInTheDocument();
  });
});
