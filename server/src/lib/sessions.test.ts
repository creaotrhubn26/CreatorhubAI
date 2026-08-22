import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  parseManifest, isValidSessionId, readManifestRaw, readSession, mapManifestStatus,
} from "./sessions.js";
import type { ArchitecturePlan, ArchitectReview, DeliveryReview, GlimmerTask } from "@glimmer/shared";
import type { TaskContract } from "@glimmer/shared";

const REAL_MANIFEST = {
  version: "2.1",
  sessionId: "20260816-181928",
  workspace: "/Users/danielqazi/glimmer-glimmer-v2-smoke-20260816-134035",
  branch: "glimmer/glimmer-v2-smoke-20260816-134035",
  baseline: "42fe48ab49aac02747c65802a003ed977eb9da38",
  task: "Make exactly one minimal, behavior-preserving documentation-only improvement.",
  maxRepairs: 1,
  verificationLevel: "minimal",
  attempts: [
    {
      iteration: 0,
      engineerReturnCode: 0,
      changedFiles: ["frontend/client/env.d.ts"],
      verificationCommands: ["git diff --check", "npm --prefix frontend run typecheck"],
      verificationResults: [
        { command: "git diff --check", returncode: 0, status: "PASS", ok: true, elapsedSeconds: 0.02, outputTail: "" },
        {
          command: "npm --prefix frontend run typecheck", returncode: 2, status: "PASS_BASELINE", ok: true,
          elapsedSeconds: 6.46, outputTail: "error TS2688...",
          baselineAccepted: true, newErrorSignatures: [],
        },
      ],
      status: "verified",
    },
  ],
  status: "verified",
  updatedAt: "2026-08-16T16:23:20.283745+00:00",
  finalHead: "42fe48ab49aac02747c65802a003ed977eb9da38",
  finalChangedFiles: ["frontend/client/env.d.ts"],
};

describe("parseManifest", () => {
  it("maps a real glimmer-v2.py manifest to GlimmerSession", () => {
    const session = parseManifest(REAL_MANIFEST, "20260816-181928-glimmer-glimmer-v2-smoke-20260816-134035");
    expect(session.id).toBe("20260816-181928-glimmer-glimmer-v2-smoke-20260816-134035");
    expect(session.status).toBe("verified");
    expect(session.branch).toBe("glimmer/glimmer-v2-smoke-20260816-134035");
    expect(session.headSha).toBe("42fe48ab49aac02747c65802a003ed977eb9da38");
    expect(session.changedFiles).toEqual([{ path: "frontend/client/env.d.ts", status: "modified" }]);
    expect(session.repairBudget).toBe(1);
    expect(session.repairsUsed).toBe(0);
    expect(session.verification.overall).toBe("VERIFIED");
    expect(session.verification.checks).toHaveLength(2);
    expect(session.verification.checks[1].status).toBe("PASS_BASELINE");
    expect(session.verification.checks[1].newErrorSignatures).toEqual([]);
  });

  it("maps an in-progress manifest with no attempts to a non-terminal status", () => {
    const session = parseManifest(
      { ...REAL_MANIFEST, attempts: [], status: "initialized" },
      "sid-2"
    );
    expect(session.status).toBe("preflight");
    expect(session.verification.overall).toBe("NOT_RUN");
  });

  it("classifies a hard FAIL/ERROR check (not baseline-related) as FAILED overall", () => {
    const session = parseManifest(
      {
        ...REAL_MANIFEST,
        attempts: [
          {
            ...REAL_MANIFEST.attempts[0],
            verificationResults: [
              { command: "npm test", returncode: 1, status: "FAIL", ok: false, elapsedSeconds: 1.1, outputTail: "", newErrorSignatures: [] },
            ],
          },
        ],
      },
      "sid-3"
    );
    expect(session.verification.overall).toBe("FAILED");
  });

  it("passes through gates/architectPlan/failure when the manifest carries them (C2/C3)", () => {
    const session = parseManifest(
      {
        ...REAL_MANIFEST,
        gates: { architectureApproved: true },
        architectPlan: { used: true, risk: "low" },
        failure: null,
      },
      "sid-4"
    );
    expect(session.gates).toEqual({ architectureApproved: true });
    expect(session.architectPlan).toEqual({ used: true, risk: "low" });
    // "failure": null in a real manifest (no failure occurred) must not turn
    // into a truthy `{}` on the session.
    expect(session.failure).toBeUndefined();
  });

  it("leaves gates/architectPlan/failure undefined for a pre-architect-mode manifest", () => {
    const session = parseManifest(REAL_MANIFEST, "sid-5");
    expect(session.gates).toBeUndefined();
    expect(session.architectPlan).toBeUndefined();
    expect(session.failure).toBeUndefined();
  });

  it("passes through a real failure object", () => {
    const session = parseManifest(
      { ...REAL_MANIFEST, failure: { class: "SCOPE_FAILURE", detail: "changed files exceeded scope", evidenceIds: ["ev-1"] } },
      "sid-6"
    );
    expect(session.failure).toEqual({ class: "SCOPE_FAILURE", detail: "changed files exceeded scope", evidenceIds: ["ev-1"] });
  });
});

describe("mapManifestStatus", () => {
  // Ground truth: glimmer-v2.py's manifest["status"] assignment sites.
  it.each([
    ["initialized", "preflight"],
    ["repo-map-only", "cancelled"],
    ["verified", "verified"],
    ["no-change-verified", "verified"],
    ["no-change-unverified", "needs_review"],
    ["blocked-infra_blocked", "blocked"],
    ["blocked-timeout", "blocked"],
    ["blocked-no-changes", "blocked"],
    ["failed-verifier-mutated-repo", "failed"],
    ["failed-repair-budget-exhausted", "failed"],
    ["failed-aborted", "failed"],
    ["cancelled-sigterm", "cancelled"],
    ["needs-architect-review", "needs_review"],
    ["needs-architect-review-rejected", "needs_review"],
    ["needs-architect-review-budget-exhausted", "needs_review"],
    ["something-nobody-has-seen", "needs_review"],
  ])("maps %s -> %s", (raw, expected) => {
    expect(mapManifestStatus(raw)).toBe(expected);
  });

  it("carries the mapped status through parseManifest and marks blocked sessions complete", () => {
    const session = parseManifest({ ...REAL_MANIFEST, status: "blocked-timeout" }, "sid-blocked");
    expect(session.status).toBe("blocked");
    expect(session.completedAt).toBe(REAL_MANIFEST.updatedAt);
  });

  it("maps repo-map-only and unknown statuses to a status that is NOT in-flight, and sets completedAt", () => {
    const IN_FLIGHT = new Set([
      "preflight", "understanding", "discovery", "candidate_selection",
      "implementing", "verifying", "repairing", "waiting_for_approval",
    ]);
    const repoMapOnly = parseManifest({ ...REAL_MANIFEST, status: "repo-map-only", attempts: [] }, "sid-repo-map-only");
    expect(IN_FLIGHT.has(repoMapOnly.status)).toBe(false);
    expect(repoMapOnly.completedAt).toBe(REAL_MANIFEST.updatedAt);

    const unknown = parseManifest({ ...REAL_MANIFEST, status: "some-future-status", attempts: [] }, "sid-unknown");
    expect(IN_FLIGHT.has(unknown.status)).toBe(false);
    expect(unknown.completedAt).toBe(REAL_MANIFEST.updatedAt);
  });
});

describe("isValidSessionId", () => {
  it("accepts real session id shapes", () => {
    expect(isValidSessionId("20260816-181928-glimmer-x")).toBe(true);
    expect(isValidSessionId("20260816-181928")).toBe(true);
  });

  it("rejects path-traversal and path-separator ids", () => {
    expect(isValidSessionId("../x")).toBe(false);
    expect(isValidSessionId("../../evil")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("/etc/passwd")).toBe(false);
  });

  it("rejects bare '..' and '.' even though every character is individually allowed", () => {
    expect(isValidSessionId("..")).toBe(false);
    expect(isValidSessionId(".")).toBe(false);
  });
});

describe("readManifestRaw / readSession path-traversal guard", () => {
  it("resolves an invalid session id to null instead of reading outside sessionsDir", async () => {
    expect(await readManifestRaw("../../evil")).toBeNull();
    expect(await readSession("../../evil")).toBeNull();
  });
});

const REAL_CONTRACT: TaskContract = {
  objective: "Fix dialog state restoration",
  scope: { package: "frontend", area: "frontend/client/src/dialog" },
  mode: "implement",
  constraints: { minimalChange: true, noCommit: true, noPush: true, noDeploy: true, noDependencyInstall: true },
  verification: ["frontend-typecheck"],
  repairBudget: 2,
};

// Isolate these fs-touching tests from the real ~/.muse-glimmer: reset the
// module registry and re-import sessions.js under a temp GLIMMER_STATE_ROOT,
// mirroring sessionAdoption.test.ts's setup. The statically-imported
// functions above (used by the pure/in-memory tests) keep referencing the
// original module instance and are unaffected.
let contractStateRoot: string;
let sessionsIsolated: typeof import("./sessions.js");

beforeAll(async () => {
  contractStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-contract-root-"));
  process.env.GLIMMER_STATE_ROOT = contractStateRoot;
  await fs.mkdir(path.join(contractStateRoot, "sessions"), { recursive: true });
  vi.resetModules();
  sessionsIsolated = await import("./sessions.js");
});

afterAll(async () => {
  await fs.rm(contractStateRoot, { recursive: true, force: true });
});

describe("gateway contract persistence", () => {
  it("round-trips a written contract", async () => {
    const dir = path.join(contractStateRoot, "sessions", "20260817-000000-glimmer-test");
    await fs.mkdir(dir, { recursive: true });
    await sessionsIsolated.writeGatewayContract(dir, REAL_CONTRACT);
    const read = await sessionsIsolated.readGatewayContract("20260817-000000-glimmer-test");
    expect(read).toEqual(REAL_CONTRACT);
  });

  it("returns null when no contract was ever written for a session", async () => {
    const dir = path.join(contractStateRoot, "sessions", "20260817-000001-glimmer-nocontract");
    await fs.mkdir(dir, { recursive: true });
    expect(await sessionsIsolated.readGatewayContract("20260817-000001-glimmer-nocontract")).toBeNull();
  });
});

describe("readSession populates taskContract", () => {
  it("attaches the persisted contract to the returned GlimmerSession", async () => {
    const id = "20260817-000002-glimmer-withcontract";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...REAL_MANIFEST, sessionId: id }));
    await sessionsIsolated.writeGatewayContract(dir, REAL_CONTRACT);
    const session = await sessionsIsolated.readSession(id);
    expect(session?.taskContract).toEqual(REAL_CONTRACT);
  });
});

// Ground truth for these fixtures: real artifacts from a VERIFIED session
// with an APPROVED_WITH_CONDITIONS review, read from
// ~/.muse-glimmer/sessions/20260820-230811-glimmer-smoke-test-r1/.
const REAL_PLAN: ArchitecturePlan = {
  objective: "Add a whisper(name) function to src/greet.js.",
  packages: ["glimmer-smoke-test"],
  risk: "low",
  area: "src/greet.js",
  existingPatterns: [{ name: "CommonJS named export object", evidence: ["src/greet.js"] }],
  candidateFiles: [{ path: "src/greet.js", reason: "target for adding whisper", confidence: 0.95 }],
  constraints: ["minimalChange true"],
  implementationPlan: ["Add function whisper(name)"],
  verificationPlan: ["Run npm run typecheck"],
  uncertainties: ["No tests found in repository"],
  expectedScope: { minFiles: 1, maxFiles: 1 },
};

const REAL_REVIEW: ArchitectReview = {
  decision: "APPROVED_WITH_CONDITIONS",
  confidence: 0.88,
  findings: ["src/greet.js now contains whisper(name)"],
  requiredChanges: [],
  constraints: ["Keep change minimal to src/greet.js only"],
  verificationAdjustments: ["Run npm run typecheck"],
};

const REAL_DELIVERY_REVIEW: DeliveryReview = {
  summary: "src/greet.js now defines whisper(name).",
  customerReadiness: "ready_with_known_limitations",
  confidence: { level: "medium", reason: "File content confirmed by read-back." },
  approachRationale: ["Added whisper as a minimal additive function."],
  strengths: ["Implementation matches required signature."],
  concerns: [{ severity: "medium", category: "verification", description: "No non-destructive validation ran.", evidenceIds: ["ev-1"] }],
  unresolvedItems: ["Runtime validation not performed."],
  intentionallyNotChanged: ["greet function implementation."],
  nextSteps: [{ priority: "recommended_next", action: "Run a quick node sanity check." }],
};

const REAL_TASKS: GlimmerTask[] = [
  { id: "t1", description: "Inspect src/greet.js", kind: "implementation", dependsOn: [], status: "complete" },
  { id: "t2", description: "Add whisper", kind: "implementation", dependsOn: ["t1"], status: "complete" },
  { id: "t3", description: "Manual smoke test", kind: "verification", dependsOn: ["t2"], status: "pending" },
];

describe("opt-in orchestrator artifact reads", () => {
  it("readArchitecturePlan returns the parsed plan when present", async () => {
    const id = "20260817-000030-glimmer-plan";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architecture-plan.json"), JSON.stringify(REAL_PLAN));
    expect(await sessionsIsolated.readArchitecturePlan(id)).toEqual(REAL_PLAN);
  });

  it("readArchitecturePlan returns null when the file is absent (normal, opt-in)", async () => {
    const id = "20260817-000031-glimmer-no-plan";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readArchitecturePlan(id)).toBeNull();
  });

  it("readArchitecturePlan returns null (not throws) on malformed JSON", async () => {
    const id = "20260817-000032-glimmer-bad-plan";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architecture-plan.json"), "not json {{{");
    expect(await sessionsIsolated.readArchitecturePlan(id)).toBeNull();
  });

  it("readArchitecturePlan rejects a path-traversal id as not-found", async () => {
    expect(await sessionsIsolated.readArchitecturePlan("../../evil")).toBeNull();
  });

  it("readDeliveryReview returns the parsed review when present", async () => {
    const id = "20260817-000033-glimmer-delivery-review";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-review.json"), JSON.stringify(REAL_DELIVERY_REVIEW));
    expect(await sessionsIsolated.readDeliveryReview(id)).toEqual(REAL_DELIVERY_REVIEW);
  });

  it("readDeliveryReview returns null when absent", async () => {
    const id = "20260817-000034-glimmer-no-delivery-review";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readDeliveryReview(id)).toBeNull();
  });

  it("readSessionTasks returns the parsed task list when present", async () => {
    const id = "20260817-000035-glimmer-tasks";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify(REAL_TASKS));
    expect(await sessionsIsolated.readSessionTasks(id)).toEqual(REAL_TASKS);
  });

  it("readSessionTasks returns null when absent", async () => {
    const id = "20260817-000036-glimmer-no-tasks";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readSessionTasks(id)).toBeNull();
  });

  it("readArchitectReviews globs and sorts architect-review-NN-MM.json", async () => {
    const id = "20260817-000037-glimmer-reviews";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const round2 = { ...REAL_REVIEW, decision: "REVISE_IMPLEMENTATION" as const };
    await fs.writeFile(path.join(dir, "architect-review-00-02.json"), JSON.stringify(round2));
    await fs.writeFile(path.join(dir, "architect-review-00-01.json"), JSON.stringify(REAL_REVIEW));
    await fs.writeFile(path.join(dir, "not-a-review.json"), JSON.stringify({ unrelated: true }));

    const reviews = await sessionsIsolated.readArchitectReviews(id);
    expect(reviews).toEqual([REAL_REVIEW, round2]);
  });

  it("readArchitectReviews skips a malformed individual review file instead of failing the whole batch", async () => {
    const id = "20260817-000038-glimmer-reviews-malformed";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architect-review-00-01.json"), JSON.stringify(REAL_REVIEW));
    await fs.writeFile(path.join(dir, "architect-review-00-02.json"), "not json {{{");

    expect(await sessionsIsolated.readArchitectReviews(id)).toEqual([REAL_REVIEW]);
  });

  it("readArchitectReviews returns null when no review files exist (normal, opt-in)", async () => {
    const id = "20260817-000039-glimmer-no-reviews";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readArchitectReviews(id)).toBeNull();
  });

  it("readArchitectReviews returns null when every matching file is malformed", async () => {
    const id = "20260817-000040-glimmer-reviews-all-malformed";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "architect-review-00-01.json"), "not json {{{");
    expect(await sessionsIsolated.readArchitectReviews(id)).toBeNull();
  });
});

describe("human acceptance (§14 Diff Review)", () => {
  it("readHumanAcceptance returns null when no one has accepted yet (normal)", async () => {
    const id = "20260817-000050-glimmer-not-accepted";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readHumanAcceptance(id)).toBeNull();
  });

  it("writeHumanAcceptance writes human-acceptance.json and readHumanAcceptance reflects it", async () => {
    const id = "20260817-000051-glimmer-accept";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });

    const record = await sessionsIsolated.writeHumanAcceptance(id);
    expect(record.accepted).toBe(true);
    expect(typeof record.acceptedAt).toBe("string");

    const onDisk = JSON.parse(
      await fs.readFile(path.join(contractStateRoot, "sessions", id, "human-acceptance.json"), "utf-8")
    );
    expect(onDisk).toEqual(record);
    expect(await sessionsIsolated.readHumanAcceptance(id)).toEqual(record);
  });

  it("writeHumanAcceptance is idempotent — accepting an already-accepted session returns the original record unchanged", async () => {
    const id = "20260817-000052-glimmer-accept-twice";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });

    const first = await sessionsIsolated.writeHumanAcceptance(id);
    const second = await sessionsIsolated.writeHumanAcceptance(id);
    expect(second).toEqual(first);
  });

  it("readSession attaches humanAcceptance once accepted", async () => {
    const id = "20260817-000053-glimmer-accept-in-session";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...REAL_MANIFEST, sessionId: id }));

    const before = await sessionsIsolated.readSession(id);
    expect(before?.humanAcceptance).toBeUndefined();

    await sessionsIsolated.writeHumanAcceptance(id);
    const after = await sessionsIsolated.readSession(id);
    expect(after?.humanAcceptance?.accepted).toBe(true);
  });
});

// V7 §20 session-level verification freeze: verifiedAt pass-through +
// gateway-computed "stale" status. Uses a real temp git repo as the
// session's workspace, same fixture pattern as git.test.ts's gitStatus
// coverage, since staleness is decided by real `git status --porcelain`
// output, not a mock.
describe("session-level verification freeze (V7 §20)", () => {
  const exec = promisify(execFile);
  let verifiedWorkspace: string;

  const verifiedManifest = () => ({
    ...REAL_MANIFEST,
    status: "verified",
    verifiedAt: "2026-08-21T00:00:00.000Z",
    workspace: verifiedWorkspace,
  });

  beforeAll(async () => {
    verifiedWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-verified-ws-"));
    await exec("git", ["init", "-q"], { cwd: verifiedWorkspace });
    await exec("git", ["config", "user.email", "t@t.com"], { cwd: verifiedWorkspace });
    await exec("git", ["config", "user.name", "t"], { cwd: verifiedWorkspace });
    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "one\n");
    await exec("git", ["add", "a.txt"], { cwd: verifiedWorkspace });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: verifiedWorkspace });
  });

  afterAll(async () => {
    await fs.rm(verifiedWorkspace, { recursive: true, force: true });
  });

  it("parseManifest passes verifiedAt through when present, leaves it undefined otherwise", () => {
    const withIt = parseManifest(verifiedManifest(), "sid-verified-at");
    expect(withIt.verifiedAt).toBe("2026-08-21T00:00:00.000Z");
    const withoutIt = parseManifest(REAL_MANIFEST, "sid-no-verified-at");
    expect(withoutIt.verifiedAt).toBeUndefined();
  });

  it("readSession without computeStale never touches git and reports plain verified, even with a dirty workspace", async () => {
    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "two\n"); // dirty
    const id = "20260821-000060-glimmer-stale-no-opt";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...verifiedManifest(), sessionId: id }));

    const session = await sessionsIsolated.readSession(id);
    expect(session?.status).toBe("verified");
  });

  it("readSession with computeStale reports plain verified when the workspace is clean", async () => {
    await exec("git", ["checkout", "--", "a.txt"], { cwd: verifiedWorkspace }); // clean again
    const id = "20260821-000061-glimmer-stale-clean";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...verifiedManifest(), sessionId: id }));

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("verified");
  });

  it("readSession with computeStale reports stale when the verified workspace has uncommitted changes", async () => {
    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "changed after verify\n");
    const id = "20260821-000062-glimmer-stale-dirty";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...verifiedManifest(), sessionId: id }));

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("stale");

    await exec("git", ["checkout", "--", "a.txt"], { cwd: verifiedWorkspace }); // restore for later tests
  });

  it("readSession with computeStale detects an untracked (new) file as dirty too", async () => {
    await fs.writeFile(path.join(verifiedWorkspace, "untracked-after-verify.txt"), "surprise\n");
    const id = "20260821-000063-glimmer-stale-untracked";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...verifiedManifest(), sessionId: id }));

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("stale");

    await fs.rm(path.join(verifiedWorkspace, "untracked-after-verify.txt"));
  });

  it("readSession with computeStale is NOT stale when the workspace directory no longer exists", async () => {
    const goneWorkspace = path.join(os.tmpdir(), "glimmer-workspace-that-never-existed-" + Date.now());
    const id = "20260821-000064-glimmer-stale-workspace-gone";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ ...verifiedManifest(), sessionId: id, workspace: goneWorkspace })
    );

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("verified");
  });

  it("readSession with computeStale never flips a non-verified status to stale even with a dirty workspace", async () => {
    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "dirty but not verified\n");
    const id = "20260821-000065-glimmer-stale-not-verified";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ ...verifiedManifest(), sessionId: id, status: "no-change-unverified", verifiedAt: undefined })
    );

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("needs_review");

    await exec("git", ["checkout", "--", "a.txt"], { cwd: verifiedWorkspace });
  });
});
