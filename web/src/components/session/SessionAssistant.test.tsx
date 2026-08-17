import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionAssistant } from "./SessionAssistant";
import * as client from "../../api/client";

afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("SessionAssistant", () => {
  it("submits a question and renders the returned answer, labeled as model output", async () => {
    vi.spyOn(client.glimmerApi, "askSession").mockResolvedValue({ answer: "It owns the parser state.", provenance: "model-output" });
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why was this file chosen?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText("It owns the parser state.")).toBeInTheDocument());
    expect(screen.getByText(/model/i)).toBeInTheDocument();
  });

  it("shows an error, not a fabricated answer, when the request fails", async () => {
    vi.spyOn(client.glimmerApi, "askSession").mockRejectedValue(new Error("model unreachable"));
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText(/unavailable|error/i)).toBeInTheDocument());
  });

  it("renders no write-action controls anywhere in the panel", () => {
    render(withQuery(<SessionAssistant sessionId="s1" />));
    expect(screen.queryByRole("button", { name: /commit|push|deploy|revert|cancel/i })).not.toBeInTheDocument();
  });
});
