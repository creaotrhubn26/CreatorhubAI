import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EvidencePanel } from "./EvidencePanel";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("EvidencePanel", () => {
  it("lists entries with id, kind, and relatesTo count", async () => {
    vi.spyOn(client.glimmerApi, "getEvidenceIndex").mockResolvedValue({
      entries: [
        { id: "sess-1-ev-1", kind: "file", path: "src/greet.js", toolCall: "read_file" },
        {
          id: "sess-1-ev-2", kind: "test-search", path: "src/greet.js", toolCall: "find_related_tests",
          relatesTo: [{ path: "src/greet.test.js", kind: "test" }],
        },
      ],
    });
    render(withQuery(<EvidencePanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("sess-1-ev-1")).toBeInTheDocument());
    expect(screen.getByText("sess-1-ev-2")).toBeInTheDocument();
    expect(screen.getByText("file")).toBeInTheDocument();
    expect(screen.getByText("test-search")).toBeInTheDocument();
    expect(screen.getByText("1 relation")).toBeInTheDocument();
    expect(screen.getByText("2 entries")).toBeInTheDocument();
  });

  it("clicking an entry loads its capped detail", async () => {
    vi.spyOn(client.glimmerApi, "getEvidenceIndex").mockResolvedValue({
      entries: [{ id: "sess-1-ev-1", kind: "file", path: "src/greet.js", toolCall: "read_file" }],
    });
    vi.spyOn(client.glimmerApi, "getEvidenceEntry").mockResolvedValue({
      id: "sess-1-ev-1", tool: "read_file", arguments: { path: "src/greet.js" },
      content: "export function greet() {}",
    });
    render(withQuery(<EvidencePanel sessionId="s1" />));

    await waitFor(() => expect(screen.getByText("sess-1-ev-1")).toBeInTheDocument());
    expect(client.glimmerApi.getEvidenceEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("sess-1-ev-1"));

    await waitFor(() => expect(client.glimmerApi.getEvidenceEntry).toHaveBeenCalledWith("s1", "sess-1-ev-1"));
    await waitFor(() => expect(screen.getByText(/export function greet/)).toBeInTheDocument());
    expect(screen.getByText(/tool: read_file/)).toBeInTheDocument();
  });

  it("renders nothing when the evidence index is empty/404s (absence is normal)", async () => {
    vi.spyOn(client.glimmerApi, "getEvidenceIndex").mockRejectedValue(new Error("GET .../evidence failed: 404"));
    const { container } = render(withQuery(<EvidencePanel sessionId="s1" />));

    await waitFor(() => expect(client.glimmerApi.getEvidenceIndex).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
