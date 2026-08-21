import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionAssistant } from "./SessionAssistant";
import * as client from "../../api/client";
import { loadTurns, saveTurns } from "../../state/assistantHistory";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("SessionAssistant", () => {
  it("streams a growing partial answer, then finalizes it on done", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockImplementation(async (_id, _q, onDelta) => {
      onDelta("It owns ");
      onDelta("the parser state.");
      return "It owns the parser state.";
    });
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText("It owns the parser state.")).toBeInTheDocument());
    expect(screen.getByText(/model/i)).toBeInTheDocument();
  });

  it("submits a question via the streaming path and renders the returned answer, labeled as model output", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockImplementation(async (_id, _q, onDelta) => {
      onDelta("It owns the parser state.");
      return "It owns the parser state.";
    });
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why was this file chosen?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText("It owns the parser state.")).toBeInTheDocument());
    expect(screen.getByText(/model/i)).toBeInTheDocument();
  });

  it("falls back once to the non-streaming endpoint when the stream fails at connection time (no deltas emitted)", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockRejectedValue(new Error("connection refused"));
    vi.spyOn(client.glimmerApi, "askSession").mockResolvedValue({ answer: "It owns the parser state.", provenance: "model-output" });
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText("It owns the parser state.")).toBeInTheDocument());
    expect(client.glimmerApi.askSession).toHaveBeenCalledTimes(1);
  });

  it("shows the Unavailable copy, not a fabricated answer, when both streaming and the fallback fail", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockRejectedValue(new Error("connection refused"));
    vi.spyOn(client.glimmerApi, "askSession").mockRejectedValue(new Error("model unreachable"));
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
  });

  it("shows the Unavailable copy (not a fallback retry) on a mid-stream failure after some output already arrived", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockImplementation(async (_id, _q, onDelta) => {
      onDelta("Partial");
      throw new Error("unavailable");
    });
    const askSessionSpy = vi.spyOn(client.glimmerApi, "askSession");
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
    expect(askSessionSpy).not.toHaveBeenCalled();
  });

  it("renders no write-action controls anywhere in the panel", () => {
    render(withQuery(<SessionAssistant sessionId="s1" />));
    expect(screen.queryByRole("button", { name: /commit|push|deploy|revert|cancel/i })).not.toBeInTheDocument();
  });

  it("loads persisted turns for this session on mount", () => {
    saveTurns("s1", [{ id: 1, question: "Old question?", askedAt: "2026-08-22T00:00:00.000Z", answer: "Old answer.", answeredAt: "2026-08-22T00:00:01.000Z" }]);
    render(withQuery(<SessionAssistant sessionId="s1" />));
    expect(screen.getByText("Old question?")).toBeInTheDocument();
    expect(screen.getByText("Old answer.")).toBeInTheDocument();
  });

  it("saves turns to sessionStorage as they change, under the per-session key", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockImplementation(async (_id, _q, onDelta) => {
      onDelta("Answer.");
      return "Answer.";
    });
    render(withQuery(<SessionAssistant sessionId="s2" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText("Answer.")).toBeInTheDocument());
    const persisted = loadTurns("s2");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ question: "Why?", answer: "Answer." });
  });
});
