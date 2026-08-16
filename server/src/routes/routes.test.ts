import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("GET /api/status", () => {
  it("returns a DashboardStatus-shaped payload with a model field", async () => {
    const app = createApp();
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(["ONLINE", "REACHABLE_AUTH", "OFFLINE", "UNKNOWN"]).toContain(res.body.model.status);
    expect(Array.isArray(res.body.recentSessions)).toBe(true);
  });
});
