import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

const ORIGIN = "tauri://localhost";
let app: Express;
let resetBridgeForTests: () => void;

beforeAll(async () => {
  const { createApp } = await import("../app.js");
  ({ resetBridgeForTests } = await import("./browser.js"));
  app = createApp();
});

afterEach(() => {
  resetBridgeForTests();
});

describe("browser bridge", () => {
  it("reports disconnected before any extension poll", async () => {
    const status = await request(app).get("/api/browser/status");
    expect(status.status).toBe(200);
    expect(status.body.connected).toBe(false);
  });

  it("refuses execute while no extension is connected", async () => {
    const response = await request(app)
      .post("/api/browser/execute")
      .set("Origin", ORIGIN)
      .send({ kind: "screenshot", url: "http://127.0.0.1:5183/" });
    expect(response.status).toBe(503);
  });

  it("rejects non-loopback targets and unknown kinds", async () => {
    for (const body of [
      { kind: "screenshot", url: "https://example.com/" },
      { kind: "launchMissiles", url: "http://127.0.0.1:5183/" },
    ]) {
      const response = await request(app)
        .post("/api/browser/execute")
        .set("Origin", ORIGIN)
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it("routes a command to the polling extension and returns its result", async () => {
    // Connect: one drained poll marks the bridge alive.
    await request(app).get("/api/browser/poll?wait=0");
    // supertest only dispatches once the request is awaited; .then() starts
    // it now so the poll below finds the queued command.
    const execute = request(app)
      .post("/api/browser/execute")
      .set("Origin", ORIGIN)
      .send({ kind: "domText", url: "http://localhost:5183/", selector: "h1" })
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const poll = await request(app).get("/api/browser/poll?wait=0");
    expect(poll.status).toBe(200);
    expect(poll.body.commands).toHaveLength(1);
    const command = poll.body.commands[0];
    expect(command.kind).toBe("domText");
    expect(command.selector).toBe("h1");
    const posted = await request(app)
      .post("/api/browser/result")
      .set("Origin", "chrome-extension://abcdefghijklmnopabcdefghijklmnop")
      .send({ id: command.id, ok: true, data: { text: "Dashboard" } });
    expect(posted.status).toBe(200);
    const response = await execute;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, data: { text: "Dashboard" } });
  });

  it("rejects a result for a command nobody is waiting on", async () => {
    const response = await request(app)
      .post("/api/browser/result")
      .set("Origin", ORIGIN)
      .send({ id: "stale", ok: true });
    expect(response.status).toBe(404);
  });

  it("keeps a web origin out of the write path", async () => {
    const response = await request(app)
      .post("/api/browser/result")
      .set("Origin", "https://evil.example")
      .send({ id: "x", ok: true });
    expect(response.status).toBe(403);
  });
});
