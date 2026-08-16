import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_V2 = path.join(__dirname, "__fixtures__", "fake-glimmer-v2-creates-session.mjs");

// Isolate from the real ~/.muse-glimmer before anything reads config.
let stateRoot: string;
let sessions: typeof import("./sessions.js");
let runner: typeof import("./runner.js");
let cancel: (() => void) | undefined;

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-adopt-root-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  await fs.mkdir(path.join(stateRoot, "sessions"), { recursive: true });
  sessions = await import("./sessions.js");
  runner = await import("./runner.js");
});

afterAll(async () => {
  cancel?.();
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("pending -> real session adoption", () => {
  it("aliases the pending id to the session directory the orchestrator creates itself", async () => {
    const pendingId = "pending-11111111-2222-3333-4444-555555555555";
    const pendingDir = path.join(stateRoot, "sessions", pendingId);
    await fs.mkdir(pendingDir, { recursive: true });

    const realId = "20260816-181928-glimmer-adopted";
    const before = new Set(await sessions.listSessionIds());
    expect(before.has(pendingId)).toBe(true);

    const handle = runner.runGlimmer(pendingDir, FAKE_V2, [path.join(stateRoot, "sessions", realId)], () => {});
    cancel = handle.cancel;

    const adopted = await sessions.adoptRealSessionDir(pendingId, before, 5000, 50);
    expect(adopted).toBe(realId);
    expect(sessions.resolveSessionId(pendingId)).toBe(realId);

    // A client that only ever knew the pending id now reads the real manifest.
    const session = await sessions.readSession(pendingId);
    expect(session?.id).toBe(realId);
    expect(session?.task).toBe("adopted task");
  });

  it("leaves the alias unset when the orchestrator never creates a session directory", async () => {
    const pendingId = "pending-deadbeef";
    const before = new Set(await sessions.listSessionIds());
    expect(await sessions.adoptRealSessionDir(pendingId, before, 300, 50)).toBeNull();
    expect(sessions.resolveSessionId(pendingId)).toBe(pendingId);
  });
});

describe("torn manifest.json", () => {
  it("resolves to null instead of throwing a SyntaxError into the route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); // the warning itself is asserted below
    const id = "20260816-999999-glimmer-torn";
    await fs.mkdir(path.join(stateRoot, "sessions", id), { recursive: true });
    // glimmer-v2.py rewrites manifest.json non-atomically; a poll can read this.
    await fs.writeFile(path.join(stateRoot, "sessions", id, "manifest.json"), '{"task": "half writ');

    await expect(sessions.readManifestRaw(id)).resolves.toBeNull();
    await expect(sessions.readSession(id)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled(); // still observable, just never thrown
    warn.mockRestore();
  });
});
