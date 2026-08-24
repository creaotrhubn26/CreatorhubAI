import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Writes require an allowed Origin (app.ts localOnlyGuard): a browser always
// sends one on a state-changing request, so the tests speak the same way.
const UI_ORIGIN = "http://127.0.0.1:5183";

// Process control (POST /model/start|stop) must never actually launch a
// 30B llama-server, so child_process is mocked for this whole file. execFile
// is mocked too because it must stay a function: lib/git.ts promisifies it at
// module load, and app.js pulls that in.
const spawnMock = vi.fn();
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
  execFile: (...args: any[]) => execFileMock(...args),
}));

type FakeChild = { pid: number; on: (ev: string, fn: (...a: any[]) => void) => void; unref: () => void; emit: (ev: string, ...a: any[]) => void };

function fakeChild(pid = 4242): FakeChild {
  const handlers: Record<string, (...a: any[]) => void> = {};
  return {
    pid,
    on: (ev, fn) => { handlers[ev] = fn; },
    unref: () => {},
    emit: (ev, ...a) => handlers[ev]?.(...a),
  };
}

// Isolate from the real ~/.muse-glimmer state and stand up a fake llama.cpp
// server per test (so /props can be present or absent) before importing
// anything that reads config at module-load time.
let stateRoot: string;
let modelServer: http.Server | undefined;
let startScript: string;
let stopScript: string;

async function closeModelServer() {
  if (modelServer) await new Promise<void>((resolve) => modelServer!.close(() => resolve()));
  modelServer = undefined;
}

beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockReset();
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: any[]) => args[args.length - 1](null, { stdout: "", stderr: "" }));
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-model-route-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  // Real (harmless) files: the routes refuse to spawn anything that isn't an
  // existing executable, and that refusal is itself under test.
  startScript = path.join(stateRoot, "start-glimmer.sh");
  stopScript = path.join(stateRoot, "stop-glimmer.sh");
  await fs.writeFile(startScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(stopScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.GLIMMER_MODEL_START_SCRIPT = startScript;
  process.env.GLIMMER_MODEL_STOP_SCRIPT = stopScript;
  // Nothing listening by default: port 1 refuses immediately.
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1";
});

afterEach(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  await closeModelServer();
  delete process.env.GLIMMER_MODEL_START_SCRIPT;
  delete process.env.GLIMMER_MODEL_STOP_SCRIPT;
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

  it("reports LOADING while the port answers but /health isn't 200 yet (llama-server loading the GGUF)", async () => {
    await listen((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({ error: { code: 503, message: "Loading model", type: "unavailable_error" } })
      );
    });
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).get("/api/model/status");
    expect(res.status).toBe(200);
    // The probe-derived status stays OFFLINE — /health did not say ONLINE.
    expect(res.body.status).toBe("OFFLINE");
    expect(res.body.runState).toBe("LOADING");
  });
});

describe("POST /api/model/start", () => {
  it("refuses (409) when the model server is already up, without spawning a second one", async () => {
    await listen((req, res) => {
      if (req.url === "/health") return res.writeHead(200).end("ok");
      res.writeHead(404).end();
    });
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).post("/api/model/start").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(409);
    expect(res.body.started).toBe(false);
    expect(res.body.runState).toBe("ONLINE");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns exactly the configured script (no args, no shell) and reports STARTING — never ONLINE", async () => {
    spawnMock.mockReturnValue(fakeChild());
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).post("/api/model/start").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(202);
    expect(res.body.started).toBe(true);
    expect(res.body.pid).toBe(4242);
    expect(res.body.runState).toBe("STARTING");
    // Spawning proves nothing about the model itself.
    expect(res.body.status).toBe("OFFLINE");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe(startScript);
    expect(args).toEqual([]);
    expect(opts.shell).toBeUndefined();

    // And the state machine holds across a following status poll.
    const status = await request(app).get("/api/model/status");
    expect(status.body.runState).toBe("STARTING");
  });

  it("reports a missing start script honestly (500) instead of a fake 'started'", async () => {
    process.env.GLIMMER_MODEL_START_SCRIPT = path.join(stateRoot, "does-not-exist.sh");
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).post("/api/model/start").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(500);
    expect(res.body.started).toBe(false);
    expect(res.body.error).toContain("does-not-exist.sh");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports FAILED with the process's exit code and log tail once it dies without coming up", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    await request(app).post("/api/model/start").set("Origin", UI_ORIGIN);
    await fs.writeFile(path.join(stateRoot, "model-server.log"), "error: failed to load model\n");
    child.emit("exit", 1);

    const res = await request(app).get("/api/model/status");
    expect(res.body.runState).toBe("FAILED");
    expect(res.body.exitCode).toBe(1);
    expect(res.body.logTail).toContain("failed to load model");
  });
});

describe("POST /api/model/stop", () => {
  it("is an honest no-op when nothing is running — the stop script is never run", async () => {
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).post("/api/model/stop").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(false);
    expect(res.body.runState).toBe("OFFLINE");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("runs the configured stop script and reports the state the port actually reports afterwards", async () => {
    await listen((req, res) => {
      if (req.url === "/health") return res.writeHead(200).end("ok");
      res.writeHead(404).end();
    });
    // Stand in for the real script: it kills whatever holds the port.
    execFileMock.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      void closeModelServer().then(() => cb(null, { stdout: "", stderr: "" }));
    });
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).post("/api/model/stop").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
    expect(res.body.runState).toBe("OFFLINE");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe(stopScript);
    expect(args).toEqual([]);
  });

  it("kills the process we started even in the STARTING window, where the port-keyed script cannot see it", async () => {
    // A real, detached child of our own so the process-group kill has
    // something true to act on (the port-keyed stop script finds nothing —
    // this process never binds, exactly like llama-server before it binds).
    const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
    const victim = realSpawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    victim.unref();
    spawnMock.mockReturnValue(fakeChild(victim.pid!));
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    await request(app).post("/api/model/start").set("Origin", UI_ORIGIN);
    const res = await request(app).post("/api/model/stop").set("Origin", UI_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
    // Evidence, not the script's exit code: the process is actually gone.
    expect(() => process.kill(victim.pid!, 0)).toThrow();
  });

  it("never claims a stop that did not happen: a surviving target is reported as still running", async () => {
    // The port stays up after the script runs — a slow SIGTERM, or the script
    // refusing to kill a non-llama-server process (it exits 0 either way).
    await listen((req, res) => {
      if (req.url === "/health") return res.writeHead(200).end("ok");
      res.writeHead(404).end();
    });
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const res = await request(app).post("/api/model/stop").set("Origin", UI_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(false);
    expect(res.body.runState).toBe("ONLINE");
    expect(res.body.detail).toContain("still listening");
  });
});

describe("POST /api/model/start concurrency", () => {
  it("spawns at most one process for parallel starts, and keeps that one's handle", async () => {
    spawnMock.mockImplementation(() => fakeChild(4242));
    const { createApp } = await import("../app.js");
    const app: Express = createApp();

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => request(app).post("/api/model/start").set("Origin", UI_ORIGIN))
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Nobody is told a process started that didn't, and nobody is told
    // "already running" about a process that was never spawned.
    for (const res of results) {
      expect([202, 409]).toContain(res.status);
      if (res.status === 202) expect(res.body.pid).toBe(4242);
    }
    const status = await request(app).get("/api/model/status");
    expect(status.body.runState).toBe("STARTING");
  });
});
