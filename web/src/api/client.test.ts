import { describe, it, expect, vi, afterEach } from "vitest";
import { glimmerApi, API_BASE } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("glimmerApi", () => {
  it("getStatus calls GET /api/status and returns parsed JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ model: { status: "ONLINE" } }), { status: 200 })
    );
    const status = await glimmerApi.getStatus();
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/status`, expect.anything());
    expect(status.model.status).toBe("ONLINE");
  });

  it("createSession POSTs the task contract as JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "s1" }), { status: 201 })
    );
    await glimmerApi.createSession({ objective: "x" } as any, "/ws");
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ taskContract: { objective: "x" }, workspace: "/ws" });
  });

  it("throws on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(glimmerApi.getStatus()).rejects.toThrow();
  });

  it("getTaskIntelligence calls GET /api/task-intelligence with query params", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ likelyArea: "frontend", likelyPackage: "x", suggestedVerification: [], estimatedRisk: null, provenance: "git-derived" }), { status: 200 })
    );
    const result = await glimmerApi.getTaskIntelligence({
      scopePackage: "frontend",
      scopeArea: "frontend/client/src/dialog",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/task-intelligence?scopePackage=frontend&scopeArea=${encodeURIComponent("frontend/client/src/dialog")}`,
      expect.anything()
    );
    expect(result.likelyArea).toBe("frontend");
  });

  // Task 4c(a): the composer's live state is what makes the endpoint able to
  // score risk and pick the right repo map — assert those hints actually reach
  // the wire, and that unset ones are omitted rather than sent as blanks.
  it("getTaskIntelligence forwards workspace and risk hints, omitting the ones not given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ likelyArea: null, likelyPackage: null, suggestedVerification: [], estimatedRisk: "HIGH", provenance: "deterministic-backend", repoMapStatus: "unmatched-workspace" }), { status: 200 })
    );
    await glimmerApi.getTaskIntelligence({
      scopePackage: "repository",
      workspace: "/tmp/ws",
      mode: "refactor",
      objective: "rotate the auth secrets",
      verificationLevel: "standard",
    });
    const url = fetchMock.mock.calls[0][0] as string;
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("workspace")).toBe("/tmp/ws");
    expect(query.get("mode")).toBe("refactor");
    expect(query.get("objective")).toBe("rotate the auth secrets");
    expect(query.get("verificationLevel")).toBe("standard");
    expect(query.has("candidateCount")).toBe(false);
    expect(query.has("scopeArea")).toBe(false);
  });

  it("listDirectory calls GET /api/fs/dirs with path/root/includeFiles", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ root: "/ws", path: "/ws", parent: null, entries: [], truncated: false }), { status: 200 })
    );
    await glimmerApi.listDirectory({ path: "/ws/src", root: "/ws", includeFiles: true });
    const url = fetchMock.mock.calls[0][0] as string;
    const query = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith(`${API_BASE}/api/fs/dirs?`)).toBe(true);
    expect(query.get("path")).toBe("/ws/src");
    expect(query.get("root")).toBe("/ws");
    expect(query.get("includeFiles")).toBe("1");
  });

  it("getSessionAnalysis calls GET /api/sessions/:id/analysis", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ riskScore: "HIGH", scopeGuard: null }), { status: 200 })
    );
    const result = await glimmerApi.getSessionAnalysis("s1");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/analysis`, expect.anything());
    expect(result.riskScore).toBe("HIGH");
  });

  it("getArchitecturePlan calls GET /api/sessions/:id/plan", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ objective: "Add whisper()", packages: ["p"], risk: "low" }), { status: 200 })
    );
    const result = await glimmerApi.getArchitecturePlan("s1");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/plan`, expect.anything());
    expect(result.objective).toBe("Add whisper()");
  });

  it("getArchitecturePlan rejects on a 404 (artifact absent)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    await expect(glimmerApi.getArchitecturePlan("s1")).rejects.toThrow();
  });

  it("getArchitectReviews calls GET /api/sessions/:id/architect-reviews and returns an array", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ decision: "APPROVED", confidence: 0.9 }]), { status: 200 })
    );
    const result = await glimmerApi.getArchitectReviews("s1");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/architect-reviews`, expect.anything());
    expect(result[0].decision).toBe("APPROVED");
  });

  it("getDeliveryReview calls GET /api/sessions/:id/delivery-review", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ summary: "s", customerReadiness: "ready_to_ship", confidence: { level: "high", reason: "r" } }), { status: 200 })
    );
    const result = await glimmerApi.getDeliveryReview("s1");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/delivery-review`, expect.anything());
    expect(result.customerReadiness).toBe("ready_to_ship");
  });

  it("getSessionTasks calls GET /api/sessions/:id/tasks and returns the flat task list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "t1", description: "d", kind: "implementation", dependsOn: [], status: "pending" }]), { status: 200 })
    );
    const result = await glimmerApi.getSessionTasks("s1");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/tasks`, expect.anything());
    expect(result[0].id).toBe("t1");
  });

  it("acceptSession POSTs to /api/sessions/:id/accept and returns the acceptance record", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, acceptedAt: "2026-08-21T00:00:00.000Z" }), { status: 200 })
    );
    const result = await glimmerApi.acceptSession("s1");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/accept`, expect.objectContaining({ method: "POST" }));
    expect(result).toEqual({ accepted: true, acceptedAt: "2026-08-21T00:00:00.000Z" });
  });

  it("askSession POSTs the question and returns the model's answer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answer: "It owns the parser state.", provenance: "model-output" }), { status: 200 })
    );
    const result = await glimmerApi.askSession("s1", "Why was this file chosen?");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/ask`, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ question: "Why was this file chosen?" });
    expect(result.answer).toBe("It owns the parser state.");
  });

  function sseResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("askSessionStream POSTs to the ?stream=1 endpoint, reports each delta, and resolves with the full answer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ delta: "It owns " })}\n\n`,
        `data: ${JSON.stringify({ delta: "the parser state." })}\n\n`,
        `data: ${JSON.stringify({ done: true, answer: "It owns the parser state." })}\n\n`,
      ])
    );
    const deltas: string[] = [];
    const answer = await glimmerApi.askSessionStream("s1", "Why?", (delta) => deltas.push(delta));
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/sessions/s1/ask?stream=1`, expect.objectContaining({ method: "POST" }));
    expect(deltas).toEqual(["It owns ", "the parser state."]);
    expect(answer).toBe("It owns the parser state.");
  });

  it("askSessionStream buffers a frame split across chunk boundaries instead of dropping it", async () => {
    const wholeFrame = `data: ${JSON.stringify({ delta: "It owns the parser state." })}\n\n`
      + `data: ${JSON.stringify({ done: true, answer: "It owns the parser state." })}\n\n`;
    const splitPoint = Math.floor(wholeFrame.length / 2);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([wholeFrame.slice(0, splitPoint), wholeFrame.slice(splitPoint)])
    );
    const deltas: string[] = [];
    await glimmerApi.askSessionStream("s1", "Why?", (delta) => deltas.push(delta));
    expect(deltas).toEqual(["It owns the parser state."]);
  });

  it("askSessionStream flushes a final frame that has no trailing newline", async () => {
    // No trailing "\n\n" after the done frame — a naive line-buffer that only
    // processes complete lines would drop this frame entirely.
    const frame = `data: ${JSON.stringify({ done: true, answer: "It owns the parser state." })}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([frame]));
    const answer = await glimmerApi.askSessionStream("s1", "Why?", () => {});
    expect(answer).toBe("It owns the parser state.");
  });

  it("askSessionStream rejects when the server sends an error frame, tagged so the caller can skip the fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([`data: ${JSON.stringify({ error: "unavailable" })}\n\n`]));
    await expect(glimmerApi.askSessionStream("s1", "Why?", () => {})).rejects.toMatchObject({ message: "unavailable", name: "AssistantUpstreamError" });
  });

  it("askSessionStream rejects on a non-2xx response instead of hanging", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 502 }));
    await expect(glimmerApi.askSessionStream("s1", "Why?", () => {})).rejects.toThrow();
  });

  it("askSessionStream rejects a stream that ends after deltas but never sends a done frame", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([`data: ${JSON.stringify({ delta: "Partial" })}\n\n`]) // connection just ends here
    );
    const deltas: string[] = [];
    await expect(glimmerApi.askSessionStream("s1", "Why?", (d) => deltas.push(d))).rejects.toThrow(/done frame/);
    expect(deltas).toEqual(["Partial"]); // the partial output still streamed before the truncation was detected
  });
});
