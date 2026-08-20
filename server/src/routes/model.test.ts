import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Isolate from the real ~/.muse-glimmer state and stand up a fake llama.cpp
// server per test (so /props can be present or absent) before importing
// anything that reads config at module-load time.
let stateRoot: string;
let modelServer: http.Server | undefined;

beforeEach(async () => {
  vi.resetModules();
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-model-route-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
});

afterEach(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  if (modelServer) await new Promise<void>((resolve) => modelServer!.close(() => resolve()));
  modelServer = undefined;
});

function listen(handler: http.RequestListener): Promise<void> {
  return new Promise((resolve) => {
    modelServer = http.createServer(handler);
    modelServer.listen(0, "127.0.0.1", () => {
      const addr = modelServer!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      process.env.GLIMMER_MODEL_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

describe("GET /api/model/status", () => {
  it("merges /props extras onto the /health-derived status", async () => {
    await listen((req, res) => {
      if (req.url === "/health") return res.writeHead(200).end("ok");
      if (req.url === "/props") {
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          default_generation_settings: { n_ctx: 65536, speculative: true },
          model_path: "/models/muse-glimmer-30b.gguf",
        }));
      }
      res.writeHead(404).end();
    });
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).get("/api/model/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ONLINE");
    expect(res.body.contextSize).toBe(65536);
    expect(res.body.modelPath).toBe("/models/muse-glimmer-30b.gguf");
    expect(res.body.speculativeDecoding).toBe(true);
  });

  it("still reports the /health status when /props 404s, leaving the extra fields absent (never fabricated)", async () => {
    await listen((req, res) => {
      if (req.url === "/health") return res.writeHead(200).end("ok");
      res.writeHead(404).end();
    });
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).get("/api/model/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ONLINE");
    expect(res.body.contextSize).toBeUndefined();
    expect(res.body.modelPath).toBeUndefined();
    expect(res.body.speculativeDecoding).toBeUndefined();
  });
});
