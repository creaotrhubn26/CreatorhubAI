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
});
