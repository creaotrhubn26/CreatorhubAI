import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

// Writes require an allowed Origin (app.ts localOnlyGuard): a browser always
// sends one on a state-changing request, so the tests speak the same way.
const UI_ORIGIN = "http://127.0.0.1:5183";

const exec = promisify(execFile);

// Same isolation convention as routes.test.ts: point every CONFIG-relevant
// env var at throwaway fixtures before the first import of app.js (CONFIG is
// frozen from process.env at module load). §27/§4.1 workspace creation also
// needs a real source repo + bare "origin" remote so `git fetch origin` and
// `origin/main` genuinely resolve, same as createWorkspace.test.ts's lib-level
// fixtures — this file adds HTTP-shape coverage on top (validation, status
// codes, and that GET /workspaces is untouched).
let app: Express;
let stateRoot: string;
let sourceRepo: string;
let bareOrigin: string;
let worktreeRoot: string;

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-state-"));
  sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-source-"));
  bareOrigin = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-origin-"));
  worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workspaces-route-worktrees-"));

  await exec("git", ["init", "-q", "-b", "main", sourceRepo]);
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: sourceRepo });
  await exec("git", ["config", "user.name", "t"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "a.txt"), "one\n");
  await exec("git", ["add", "a.txt"], { cwd: sourceRepo });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepo });
  await exec("git", ["init", "-q", "--bare", bareOrigin]);
  await exec("git", ["remote", "add", "origin", bareOrigin], { cwd: sourceRepo });
  await exec("git", ["push", "-q", "origin", "main"], { cwd: sourceRepo });

  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1"; // nothing listens here
  process.env.GLIMMER_SOURCE_REPO = sourceRepo;
  process.env.GLIMMER_WORKTREE_ROOT = worktreeRoot;
  process.env.GLIMMER_WORKTREE_BASE = "origin/main";

  const { createApp } = await import("../app.js");
  app = createApp();
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(sourceRepo, { recursive: true, force: true });
  await fs.rm(bareOrigin, { recursive: true, force: true });
  await fs.rm(worktreeRoot, { recursive: true, force: true });
});

describe("GET /api/workspaces (untouched)", () => {
  it("still returns an array, with no session-backed workspaces in this fixture", async () => {
    const res = await request(app).get("/api/workspaces");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// Task 4c(2/3): the composer's path pickers in a plain browser. Read-only,
// names only, and contained — these cases exist mostly to pin the containment
// rules, since this is the gateway's only filesystem-listing endpoint.
describe("GET /api/fs/dirs", () => {
  let browseRoot: string;
  let outside: string;

  beforeAll(async () => {
    // realpath: macOS tmpdir is a symlink (/var -> /private/var) and the route
    // compares resolved paths, so the fixture must be expressed the same way.
    browseRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-browse-root-")),
    );
    outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-browse-outside-")),
    );
    process.env.GLIMMER_BROWSE_ROOT = browseRoot;

    await fs.mkdir(path.join(browseRoot, "project", "src"), { recursive: true });
    await fs.writeFile(path.join(browseRoot, "project", "README.md"), "FILE-BODY-MARKER");
    await fs.writeFile(path.join(browseRoot, "project", ".hidden"), "x");
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(outside, path.join(browseRoot, "escape-hatch"));
  });

  afterAll(async () => {
    delete process.env.GLIMMER_BROWSE_ROOT;
    await fs.rm(browseRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("lists subdirectory names only, hiding files by default", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project"))}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ name: "src", isDir: true }]);
    expect(res.body.path).toBe(path.join(browseRoot, "project"));
    expect(res.body.truncated).toBe(false);
  });

  it("includes file names (never contents) when includeFiles=1", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project"))}&includeFiles=1`,
    );
    expect(res.status).toBe(200);
    // Review MJ2: ordinary dotfiles are listed now — .hidden here stands for
    // the .github/.env/dot-named-repo content the picker has to be able to see.
    expect(res.body.entries).toEqual([
      { name: ".hidden", isDir: false },
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("FILE-BODY-MARKER");
  });

  it("reports no parent at the root, so the UI can never walk above it", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(browseRoot)}`);
    expect(res.status).toBe(200);
    expect(res.body.parent).toBeNull();
  });

  it("rejects ../ traversal out of the browse root", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "..", ".."))}`,
    );
    expect(res.status).toBe(403);
  });

  it("rejects an absolute path outside the browse root", async () => {
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(outside)}`);
    expect(res.status).toBe(403);
  });

  it("rejects a symlink that escapes the root, even though it lives inside it", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "escape-hatch"))}`,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a caller-supplied root outside the browse root (scope picker can't widen the boundary)", async () => {
    const res = await request(app).get(
      `/api/fs/dirs?root=${encodeURIComponent(outside)}&path=${encodeURIComponent(outside)}`,
    );
    expect(res.status).toBe(403);
  });

  it("confines the listing to a caller-supplied root inside the boundary", async () => {
    const root = path.join(browseRoot, "project");
    const inside = await request(app).get(
      `/api/fs/dirs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path.join(root, "src"))}`,
    );
    expect(inside.status).toBe(200);
    expect(inside.body.parent).toBe(root);

    const above = await request(app).get(
      `/api/fs/dirs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(browseRoot)}`,
    );
    expect(above.status).toBe(403);
  });

  // Review MJ1: realpath() used to run before the containment check, so the
  // status code told the caller whether an arbitrary path ANYWHERE on the disk
  // existed (403 = exists, 404 = doesn't). Outside the boundary, existence must
  // make no observable difference.
  it("answers identically for existing and non-existent paths outside the boundary (no existence oracle)", async () => {
    const existing = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(outside)}`);
    const missing = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(outside, "definitely-not-here-zzz"))}`,
    );
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(existing.status);
    expect(missing.body).toEqual(existing.body);

    // Same for absolute system paths the boundary has nothing to do with.
    const realSystemPath = await request(app).get("/api/fs/dirs?path=%2Fetc");
    const fakeSystemPath = await request(app).get(
      "/api/fs/dirs?path=%2Fetc-not-a-real-directory-zzz",
    );
    expect(realSystemPath.status).toBe(403);
    expect(fakeSystemPath.status).toBe(403);
    expect(fakeSystemPath.body).toEqual(realSystemPath.body);
  });

  // Review MJ2: the old dotfile filter applied to listed entries but not to the
  // requested path, so ~/.ssh was directly listable while a legitimate
  // dot-named workspace was unreachable. Both halves are now explicit.
  describe("hidden and sensitive paths", () => {
    it("refuses to browse a credential directory, and never lists one as an entry", async () => {
      await fs.mkdir(path.join(browseRoot, ".ssh"), { recursive: true });
      await fs.writeFile(path.join(browseRoot, ".ssh", "id_ed25519"), "PRIVATE");

      const direct = await request(app).get(
        `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, ".ssh"))}&includeFiles=1`,
      );
      expect(direct.status).toBe(403);
      expect(JSON.stringify(direct.body)).not.toContain("id_ed25519");

      const listing = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(browseRoot)}`);
      expect(listing.body.entries.map((e: { name: string }) => e.name)).not.toContain(".ssh");
    });

    it("refuses a credential directory at any depth, not just at the boundary", async () => {
      await fs.mkdir(path.join(browseRoot, "project", ".aws"), { recursive: true });
      const res = await request(app).get(
        `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project", ".aws"))}&includeFiles=1`,
      );
      expect(res.status).toBe(403);
    });

    it("still lists and enters an ordinary dot-named directory — a dot-named repo is pickable project content", async () => {
      await fs.mkdir(path.join(browseRoot, ".smoke-test-repo", "src"), { recursive: true });

      const listing = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(browseRoot)}`);
      expect(listing.body.entries.map((e: { name: string }) => e.name)).toContain(
        ".smoke-test-repo",
      );

      const entered = await request(app).get(
        `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, ".smoke-test-repo"))}`,
      );
      expect(entered.status).toBe(200);
      expect(entered.body.entries).toEqual([{ name: "src", isDir: true }]);
    });
  });

  // Review MN3: client errors were reported as 500s that echoed the caller's
  // own input back in the message.
  it("400s (without echoing the input) on a null byte or an over-long path", async () => {
    const nullByte = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(browseRoot + "\0/etc")}`,
    );
    expect(nullByte.status).toBe(400);
    expect(nullByte.body.error).not.toContain(browseRoot);

    const tooLong = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "a".repeat(300).split("").join("/")))}`,
    );
    expect([400, 403, 404]).toContain(tooLong.status);
    expect(tooLong.status).not.toBe(500);
  });

  it("404s for a path that does not exist, and 400s for a file", async () => {
    const missing = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "nope"))}`,
    );
    expect(missing.status).toBe(404);
    const file = await request(app).get(
      `/api/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "project", "README.md"))}`,
    );
    expect(file.status).toBe(400);
  });
});

// Round A / Task A1. Shares resolveContained() with /api/fs/dirs, so the
// containment cases below are here to pin that the SHARED check is actually
// wired up on this route too — a second, subtly different copy is the bug
// class this is guarding against.
describe("GET /api/fs/file", () => {
  let browseRoot: string;
  let outside: string;

  beforeAll(async () => {
    browseRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-file-root-")));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-file-outside-")));
    process.env.GLIMMER_BROWSE_ROOT = browseRoot;

    // Review M1: content reads are confined to a KNOWN WORKSPACE, so this
    // fixture needs a real session manifest naming one — being inside the
    // browse root is no longer enough to be readable.
    await fs.mkdir(path.join(stateRoot, "sessions", "20260824-000000-fs-file"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(stateRoot, "sessions", "20260824-000000-fs-file", "manifest.json"),
      JSON.stringify({ id: "20260824-000000-fs-file", workspace: path.join(browseRoot, "repo") }),
    );

    await fs.mkdir(path.join(browseRoot, "repo", "src"), { recursive: true });
    await fs.writeFile(
      path.join(browseRoot, "repo", "src", "a.ts"),
      "const x = 1;\nconst y = 2;\n",
    );
    await fs.writeFile(path.join(browseRoot, "repo", "empty.txt"), "");
    await fs.writeFile(path.join(outside, "secret.txt"), "TOP-SECRET-MARKER");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(browseRoot, "repo", "escape.txt"));
    await fs.mkdir(path.join(browseRoot, "repo", ".ssh"), { recursive: true });
    await fs.writeFile(path.join(browseRoot, "repo", ".ssh", "id_ed25519"), "PRIVATE-KEY-MARKER");
    // Inside the browse root, but in NO workspace — the M1 case.
    await fs.mkdir(path.join(browseRoot, ".local", "share", "opencode"), { recursive: true });
    await fs.writeFile(
      path.join(browseRoot, ".local", "share", "opencode", "auth.json"),
      "API-KEY-MARKER",
    );
  });

  afterAll(async () => {
    delete process.env.GLIMMER_BROWSE_ROOT;
    await fs.rm(browseRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const get = (p: string) => request(app).get(`/api/fs/file?path=${encodeURIComponent(p)}`);
  const askSelection = (selection: unknown, question = "What does this do?") =>
    request(app).post("/api/repository/ask").set("Origin", UI_ORIGIN).send({ question, selection });

  it("validates a sessionless repository selection before any model request", async () => {
    const missingQuestion = await askSelection(
      {
        path: path.join(browseRoot, "repo", "src", "a.ts"),
        startLine: 1,
        endLine: 1,
      },
      "",
    );
    expect(missingQuestion.status).toBe(400);
    expect(missingQuestion.body.error).toBe("question is required");

    const backwards = await askSelection({
      path: path.join(browseRoot, "repo", "src", "a.ts"),
      startLine: 2,
      endLine: 1,
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error).toMatch(/valid repository selection/i);

    const pastExcerpt = await askSelection({
      path: path.join(browseRoot, "repo", "src", "a.ts"),
      startLine: 1,
      endLine: 99,
    });
    expect(pastExcerpt.status).toBe(400);
    expect(pastExcerpt.body.error).toMatch(/outside the file excerpt/i);
  });

  it("gives the selection route the same workspace confinement and no-existence-oracle answer as the viewer", async () => {
    const existing = await askSelection({
      path: path.join(outside, "secret.txt"),
      startLine: 1,
      endLine: 1,
    });
    const missing = await askSelection({
      path: path.join(outside, "not-real.txt"),
      startLine: 1,
      endLine: 1,
    });
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual(existing.body);
  });

  it("returns the file's text with its real size, untruncated and not binary", async () => {
    const res = await get(path.join(browseRoot, "repo", "src", "a.ts"));
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("const x = 1;\nconst y = 2;\n");
    expect(res.body.size).toBe(26);
    expect(res.body.bytesReturned).toBe(26);
    expect(res.body.truncated).toBe(false);
    expect(res.body.binary).toBe(false);
    expect(res.body.path).toBe(path.join(browseRoot, "repo", "src", "a.ts"));
  });

  it('distinguishes a genuinely empty file (content "") from a refused read (content null)', async () => {
    const res = await get(path.join(browseRoot, "repo", "empty.txt"));
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("");
    expect(res.body.binary).toBe(false);
    expect(res.body.size).toBe(0);
  });

  it("truncates a large file honestly: real size, fewer bytes returned, truncated=true", async () => {
    const big = path.join(browseRoot, "repo", "big.txt");
    // 700 KiB of whole lines — comfortably past the 512 KiB ceiling.
    await fs.writeFile(big, "0123456789abcdefghijklmnopqrstuvwxyz012345678\n".repeat(16000));
    const onDisk = (await fs.stat(big)).size;

    const res = await get(big);
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.size).toBe(onDisk);
    expect(res.body.bytesReturned).toBeLessThan(onDisk);
    expect(res.body.bytesReturned).toBeLessThanOrEqual(512 * 1024);
    expect(res.body.content.length).toBeGreaterThan(0);
    // Cut back to a line boundary, so the viewer never shows half a line.
    expect(res.body.content.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(res.body.content)).toBe(res.body.bytesReturned);
  });

  it('refuses binary content instead of returning garbage, with content null (not "")', async () => {
    const bin = path.join(browseRoot, "repo", "logo.png");
    await fs.writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    const res = await get(bin);
    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);
    expect(res.body.content).toBeNull();
    expect(res.body.bytesReturned).toBe(0);
    expect(res.body.size).toBe(8);
  });

  // Review m1: git's heuristic stops at 8000 bytes, so a NUL past that mark
  // used to be served as "text" with the NUL embedded in the JSON. The sniff
  // now covers every byte the response would carry.
  it("detects a NUL past the first 8000 bytes rather than serving it as text", async () => {
    const late = path.join(browseRoot, "repo", "late-nul.bin");
    await fs.writeFile(
      late,
      Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00]), Buffer.alloc(1000, 0x62)]),
    );
    const res = await get(late);
    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);
    expect(res.body.content).toBeNull();
  });

  it("rejects ../ traversal, an absolute path outside the boundary, and a symlink that escapes it", async () => {
    const traversal = await get(path.join(browseRoot, "..", "..", "etc", "hosts"));
    expect(traversal.status).toBe(403);

    const absolute = await get(path.join(outside, "secret.txt"));
    expect(absolute.status).toBe(403);
    expect(JSON.stringify(absolute.body)).not.toContain("TOP-SECRET-MARKER");

    // Lives inside the boundary, resolves outside it: visible, never readable.
    const symlinked = await get(path.join(browseRoot, "repo", "escape.txt"));
    expect(symlinked.status).toBe(403);
    expect(JSON.stringify(symlinked.body)).not.toContain("TOP-SECRET-MARKER");
  });

  it("answers identically for existing and non-existent paths outside the boundary (no existence oracle)", async () => {
    const existing = await get(path.join(outside, "secret.txt"));
    const missing = await get(path.join(outside, "definitely-not-here-zzz.txt"));
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(existing.status);
    expect(missing.body).toEqual(existing.body);
  });

  it("refuses a credential name inside the workspace too, at its root or deeper", async () => {
    const atRoot = await get(path.join(browseRoot, "repo", ".ssh", "id_ed25519"));
    expect(atRoot.status).toBe(403);
    expect(JSON.stringify(atRoot.body)).not.toContain("PRIVATE-KEY-MARKER");

    await fs.mkdir(path.join(browseRoot, "repo", "sub", ".aws"), { recursive: true });
    await fs.writeFile(
      path.join(browseRoot, "repo", "sub", ".aws", "credentials"),
      "PRIVATE-KEY-MARKER",
    );
    const deeper = await get(path.join(browseRoot, "repo", "sub", ".aws", "credentials"));
    expect(deeper.status).toBe(403);
    expect(JSON.stringify(deeper.body)).not.toContain("PRIVATE-KEY-MARKER");
  });

  // Review M1: the boundary for CONTENT is the known-workspace set, not the
  // browse root. These two cases are the whole point of that change.
  describe("workspace confinement", () => {
    it("reads a file inside a known workspace", async () => {
      const res = await get(path.join(browseRoot, "repo", "src", "a.ts"));
      expect(res.status).toBe(200);
      expect(res.body.content).toContain("const x = 1;");
    });

    it("refuses a file that is inside the browse root but in no workspace", async () => {
      const res = await get(path.join(browseRoot, ".local", "share", "opencode", "auth.json"));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/known workspace/i);
      expect(JSON.stringify(res.body)).not.toContain("API-KEY-MARKER");
    });

    it("takes no root from the caller — a caller-supplied root cannot widen anything", async () => {
      // Naming the secret's own directory as `root` must change nothing: the
      // server picks the root itself, from the session manifests.
      const res = await request(app).get(
        `/api/fs/file?path=${encodeURIComponent(path.join(browseRoot, ".local", "share", "opencode", "auth.json"))}` +
          `&root=${encodeURIComponent(path.join(browseRoot, ".local", "share", "opencode"))}`,
      );
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("API-KEY-MARKER");
    });

    it("still lists names over the whole browse root — the tree's job is unchanged", async () => {
      const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(browseRoot)}`);
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: { name: string }) => e.name)).toContain(".local");
      // Names only: the listing never carried contents and still does not.
      expect(JSON.stringify(res.body)).not.toContain("API-KEY-MARKER");
    });
  });

  it("400s on a directory, a missing path param, and a null byte; 404s on a path that does not exist", async () => {
    const dir = await get(path.join(browseRoot, "repo"));
    expect(dir.status).toBe(400);
    expect(dir.body.error).toMatch(/directory/i);

    const noParam = await request(app).get("/api/fs/file");
    expect(noParam.status).toBe(400);

    const nullByte = await get(path.join(browseRoot, "repo", "a.ts") + "\0/etc/passwd");
    expect(nullByte.status).toBe(400);
    expect(nullByte.body.error).not.toContain(browseRoot);

    const missing = await get(path.join(browseRoot, "repo", "nope.ts"));
    expect(missing.status).toBe(404);
  });

  it("refuses a non-regular file without opening it (a fifo would block the gateway)", async () => {
    const fifo = path.join(browseRoot, "repo", "pipe");
    try {
      await exec("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this platform — nothing to assert
    }
    const res = await get(fifo);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/regular file/i);
  });
});

describe("POST /api/workspaces — validation", () => {
  it("400s when taskName is missing", async () => {
    const res = await request(app).post("/api/workspaces").set("Origin", UI_ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/taskname/i);
  });

  it("400s when taskName is not a string", async () => {
    const res = await request(app)
      .post("/api/workspaces")
      .set("Origin", UI_ORIGIN)
      .send({ taskName: 42 });
    expect(res.status).toBe(400);
  });

  it("400s when taskName sanitizes to an empty slug", async () => {
    const res = await request(app)
      .post("/api/workspaces")
      .set("Origin", UI_ORIGIN)
      .send({ taskName: "!!!///???" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workspaces — success", () => {
  it("creates a real branch+worktree and returns {workspace, branch, baselineSha}", async () => {
    const res = await request(app)
      .post("/api/workspaces")
      .set("Origin", UI_ORIGIN)
      .send({ taskName: "route level task" });
    expect(res.status).toBe(200);
    expect(res.body.branch).toMatch(/^glimmer\/route-level-task-\d{8}-\d{6}$/);
    expect(typeof res.body.baselineSha).toBe("string");
    expect(path.resolve(res.body.workspace).startsWith(path.resolve(worktreeRoot) + path.sep)).toBe(
      true,
    );

    const headSha = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: res.body.workspace })
    ).stdout.trim();
    expect(headSha).toBe(res.body.baselineSha);
  });
});

describe("POST /api/workspaces — concurrency", () => {
  it("returns 409 for a second request fired while the first is still in flight", async () => {
    const [r1, r2] = await Promise.all([
      request(app)
        .post("/api/workspaces")
        .set("Origin", UI_ORIGIN)
        .send({ taskName: "concurrent-route-a" }),
      request(app)
        .post("/api/workspaces")
        .set("Origin", UI_ORIGIN)
        .send({ taskName: "concurrent-route-b" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
