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

  it("aliases two concurrent adoptions to two different real directories, never the same one", async () => {
    // Simulates two sessions starting within the same poll window (or one
    // adoption racing a human running glimmer-v2.py directly): both pending
    // ids share the same pre-spawn snapshot, and their real directories
    // appear close together while both polling loops are in flight.
    const pendingA = "pending-aaaaaaaa-0000-0000-0000-000000000001";
    const pendingB = "pending-bbbbbbbb-0000-0000-0000-000000000002";
    await fs.mkdir(path.join(stateRoot, "sessions", pendingA), { recursive: true });
    await fs.mkdir(path.join(stateRoot, "sessions", pendingB), { recursive: true });
    const before = new Set(await sessions.listSessionIds());

    const realA = "20260816-190001-glimmer-concurrent-a";
    const realB = "20260816-190002-glimmer-concurrent-b";

    const adoptionA = sessions.adoptRealSessionDir(pendingA, before, 3000, 20);
    const adoptionB = sessions.adoptRealSessionDir(pendingB, before, 3000, 20);

    // Stagger creation so both polling loops race for realA first (the exact
    // window the old, unclaimed-tracking-free code mis-attributed), then
    // realB appears once one adoption has already claimed realA.
    await new Promise((r) => setTimeout(r, 50));
    await fs.mkdir(path.join(stateRoot, "sessions", realA), { recursive: true });
    await new Promise((r) => setTimeout(r, 100));
    await fs.mkdir(path.join(stateRoot, "sessions", realB), { recursive: true });

    const [adoptedA, adoptedB] = await Promise.all([adoptionA, adoptionB]);

    expect(adoptedA).not.toBeNull();
    expect(adoptedB).not.toBeNull();
    expect(new Set([adoptedA, adoptedB])).toEqual(new Set([realA, realB]));
    expect(adoptedA).not.toBe(adoptedB);
    expect(sessions.resolveSessionId(pendingA)).toBe(adoptedA);
    expect(sessions.resolveSessionId(pendingB)).toBe(adoptedB);
  });

  it("F2: resolves both pending ids by spawn order when both real directories appear before either poll runs", async () => {
    // This is the exact deadlock scenario: two real session directories are
    // already on disk before EITHER polling loop has run its first tick, so
    // both loops see 2 unclaimed candidates on every tick. Pre-fix, neither
    // side ever saw exactly 1 candidate, so both pending ids timed out
    // unaliased even though both real sessions had genuinely started.
    const pendingA = "pending-f2-order-aaaa";
    const pendingB = "pending-f2-order-bbbb";
    await fs.mkdir(path.join(stateRoot, "sessions", pendingA), { recursive: true });
    await fs.mkdir(path.join(stateRoot, "sessions", pendingB), { recursive: true });
    const before = new Set(await sessions.listSessionIds());

    const realEarly = "20260817-100001-glimmer-f2-early";
    const realLate = "20260817-100002-glimmer-f2-late";

    // Both directories land on disk before either adoptRealSessionDir call
    // below even starts polling.
    await fs.mkdir(path.join(stateRoot, "sessions", realEarly), { recursive: true });
    await new Promise((r) => setTimeout(r, 50)); // determinable birthtime gap
    await fs.mkdir(path.join(stateRoot, "sessions", realLate), { recursive: true });

    // pendingA is spawned (queued) strictly before pendingB, matching the
    // order glimmer's /run route calls adoptRealSessionDir for back-to-back
    // session creations.
    const adoptionA = sessions.adoptRealSessionDir(pendingA, before, 3000, 20);
    const adoptionB = sessions.adoptRealSessionDir(pendingB, before, 3000, 20);

    const [adoptedA, adoptedB] = await Promise.all([adoptionA, adoptionB]);

    // Both resolve (no deadlock) and the earliest-spawned pending id gets
    // the earliest-created directory.
    expect(adoptedA).toBe(realEarly);
    expect(adoptedB).toBe(realLate);
    expect(sessions.resolveSessionId(pendingA)).toBe(realEarly);
    expect(sessions.resolveSessionId(pendingB)).toBe(realLate);
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
