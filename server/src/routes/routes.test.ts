import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("GET /api/status", () => {
  it("returns a DashboardStatus-shaped payload", async () => {
    const app = createApp();
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("model");
    expect(res.body).toHaveProperty("recentSessions");
  });
});
