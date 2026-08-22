import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

  it("resolves a stale pending turn (no answer, no error) to the Unavailable copy on load, instead of a permanent Asking…", () => {
    saveTurns("s1", [{ id: 1, question: "Orphaned mid-reload?", askedAt: "2026-08-22T00:00:00.000Z" }]);
    render(withQuery(<SessionAssistant sessionId="s1" />));
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Asking…$/)).not.toBeInTheDocument();
    // And the resolved state is itself persisted, not left stale on disk.
    expect(loadTurns("s1")[0]).toMatchObject({ error: "Unavailable — the assistant could not answer that." });
  });

  it("does not write session A's turns under session B's storage key on a fast session switch mid-question", async () => {
    let resolveStream!: (answer: string) => void;
    vi.spyOn(client.glimmerApi, "askSessionStream").mockImplementation(
      (_id, _q, onDelta) => new Promise<string>((resolve) => {
        onDelta("A's partial answer");
        resolveStream = resolve;
      })
    );
    saveTurns("s2", [{ id: 99, question: "B's own old question", askedAt: "2026-08-22T00:00:00.000Z", answer: "B's own old answer", answeredAt: "2026-08-22T00:00:01.000Z" }]);

    const { rerender } = render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "A's question" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText(/A's partial answer/)).toBeInTheDocument());

    // Switch to session B while A's question is still in flight (unresolved).
    rerender(withQuery(<SessionAssistant sessionId="s2" />));
    await waitFor(() => expect(screen.getByText("B's own old question")).toBeInTheDocument());

    // Resolve A's stream after the switch — must not land in B's state/storage.
    await act(async () => { resolveStream("A's full answer"); });

    expect(screen.queryByText(/A's (partial|full) answer/)).not.toBeInTheDocument();
    expect(loadTurns("s2")).toEqual([{ id: 99, question: "B's own old question", askedAt: "2026-08-22T00:00:00.000Z", answer: "B's own old answer", answeredAt: "2026-08-22T00:00:01.000Z" }]);
    const sA = loadTurns("s1");
    expect(sA.some((t) => t.question === "A's question")).toBe(true); // A's own question was still saved under A's own key before the switch
    expect(sA.some((t) => t.answer?.includes("A's full answer"))).toBe(false); // but the post-switch resolution was dropped, not merged in
  });

  it("skips the non-streaming fallback for a tagged AssistantUpstreamError even with zero deltas emitted", async () => {
    vi.spyOn(client.glimmerApi, "askSessionStream").mockImplementation(async () => {
      const err = new Error("unavailable");
      err.name = "AssistantUpstreamError";
      throw err;
    });
    const askSessionSpy = vi.spyOn(client.glimmerApi, "askSession");
    render(withQuery(<SessionAssistant sessionId="s1" />));
    fireEvent.change(screen.getByPlaceholderText(/ask about this session/i), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
    expect(askSessionSpy).not.toHaveBeenCalled();
  });
});
