import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  parseManifest, isValidSessionId, readManifestRaw, readSession, mapManifestStatus, applyTaskOverrides,
} from "./sessions.js";
import { computeDiffHash } from "./git.js";
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

  // Task 8.1 (V7 §23.11): manifest["statuses"], same optional-pass-through
  // discipline as gates/architectPlan/failure above.
  it("passes through statuses when the manifest carries them", () => {
    const session = parseManifest(
      {
        ...REAL_MANIFEST,
        statuses: {
          technical: "VERIFIED", architecture: "approved", documentation: "not_run",
          visual: "not_run", delivery: "needs_polish", overall: "needs_polish",
        },
      },
      "sid-statuses-1"
    );
    expect(session.statuses).toEqual({
      technical: "VERIFIED", architecture: "approved", documentation: "not_run",
      visual: "not_run", delivery: "needs_polish", overall: "needs_polish",
    });
  });

  it("leaves statuses undefined for a manifest predating Task 8.1", () => {
    const session = parseManifest(REAL_MANIFEST, "sid-statuses-2");
    expect(session.statuses).toBeUndefined();
  });

  it("passes through a real failure object", () => {
    const session = parseManifest(
      { ...REAL_MANIFEST, failure: { class: "SCOPE_FAILURE", detail: "changed files exceeded scope", evidenceIds: ["ev-1"] } },
      "sid-6"
    );
    expect(session.failure).toEqual({ class: "SCOPE_FAILURE", detail: "changed files exceeded scope", evidenceIds: ["ev-1"] });
  });
});

// V7 §22.17: finalStatus's functional/architecture/documentation legs are
// all synchronously derivable from the manifest, so parseManifest computes
// them directly -- readSession (below, in its own describe block) is only
// responsible for upgrading the fourth leg (`visual`) after an async read.
describe("finalStatus composition (V7 §22.17)", () => {
  it("functional mirrors verification.overall exactly", () => {
    const session = parseManifest(REAL_MANIFEST, "sid-final-1");
    expect(session.finalStatus.functional).toBe(session.verification.overall);
    expect(session.finalStatus.functional).toBe("VERIFIED");
  });

  it("defaults architecture/documentation/visual to not_run with no gates at all", () => {
    const session = parseManifest(REAL_MANIFEST, "sid-final-2");
    expect(session.finalStatus.architecture).toBe("not_run");
    expect(session.finalStatus.documentation).toBe("not_run");
    expect(session.finalStatus.visual).toBe("not_run");
  });

  it.each([
    [true, "approved"],
    [false, "rejected"],
    [null, "not_run"],
  ] as const)("gates.architectureApproved %s -> finalStatus.architecture %s", (raw, expected) => {
    const session = parseManifest({ ...REAL_MANIFEST, gates: { architectureApproved: raw } }, "sid-final-3");
    expect(session.finalStatus.architecture).toBe(expected);
  });

  it.each([
    [true, "approved"],
    [false, "rejected"],
    [null, "not_run"],
  ] as const)("gates.documentationCurrent %s -> finalStatus.documentation %s", (raw, expected) => {
    const session = parseManifest({ ...REAL_MANIFEST, gates: { documentationCurrent: raw } }, "sid-final-4");
    expect(session.finalStatus.documentation).toBe(expected);
  });

  it("a manifest with no attempts (NOT_RUN) reports functional NOT_RUN, not a crash", () => {
    const session = parseManifest({ ...REAL_MANIFEST, attempts: [], status: "initialized" }, "sid-final-5");
    expect(session.finalStatus.functional).toBe("NOT_RUN");
  });
});

describe("mapManifestStatus", () => {
  // Ground truth: glimmer-v2.py's manifest["status"] assignment sites.
  it.each([
    ["initialized", "preflight"],
    ["understanding", "understanding"],
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

  // Task 8.2 (V7 §23.15): architect-escalation.json is merged onto the
  // DeliveryReview response at read time, not served as its own route.
  it("readDeliveryReview merges architect-escalation.json onto the review when present", async () => {
    const id = "20260821-000001-glimmer-escalation";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-review.json"), JSON.stringify(REAL_DELIVERY_REVIEW));
    await fs.writeFile(
      path.join(dir, "architect-escalation.json"),
      JSON.stringify({ question: "Is this sound?", answer: "Yes, proceed." })
    );
    expect(await sessionsIsolated.readDeliveryReview(id)).toEqual({
      ...REAL_DELIVERY_REVIEW,
      architectEscalation: { question: "Is this sound?", answer: "Yes, proceed." },
    });
  });

  it("readDeliveryReview omits architectEscalation when no escalation ran for this session", async () => {
    const id = "20260821-000002-glimmer-no-escalation";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "delivery-review.json"), JSON.stringify(REAL_DELIVERY_REVIEW));
    expect(await sessionsIsolated.readDeliveryReview(id)).toEqual(REAL_DELIVERY_REVIEW);
  });

  // Task 8.2 (V7 §23.16): delivery-packet.json, same opt-in-artifact
  // convention as every other session-dir read above.
  it("readDeliveryPacket returns the parsed packet when present", async () => {
    const id = "20260821-000003-glimmer-packet";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    const packet = {
      task: "add widget", planRef: null, changedFiles: ["a.ts"], orchestratorUpdatedFiles: [],
      verification: { status: "VERIFIED", results: null }, visual: "not_run",
      statuses: { technical: "VERIFIED", architecture: "not_run", documentation: "not_run", visual: "not_run", delivery: "not_run", overall: "not_run" },
      customerReadiness: null, limitations: null, forwardPlan: null, confidence: null,
      humanReviewStatus: "pending",
    };
    await fs.writeFile(path.join(dir, "delivery-packet.json"), JSON.stringify(packet));
    expect(await sessionsIsolated.readDeliveryPacket(id)).toEqual(packet);
  });

  it("readDeliveryPacket returns null when absent (normal, opt-in)", async () => {
    const id = "20260821-000004-glimmer-no-packet";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readDeliveryPacket(id)).toBeNull();
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

  it("readSessionTasks unwraps the Task 4.1 v2 {schemaVersion, tasks} wrapper", async () => {
    const id = "20260822-000037-glimmer-tasks-v2";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tasks.json"),
      JSON.stringify({ schemaVersion: 2, tasks: REAL_TASKS })
    );
    expect(await sessionsIsolated.readSessionTasks(id)).toEqual(REAL_TASKS);
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

const REAL_VISUAL_MANIFEST = {
  route: "http://localhost:5183/role-room",
  viewports: ["1440x900", "390x844"],
  states: ["initial"],
  status: "pass",
  captures: [
    { viewport: "1440x900", screenshot: "1440x900.png", status: "captured", error: null },
    { viewport: "390x844", screenshot: "390x844.png", status: "captured", error: null },
  ],
};

describe("visual verification reads + finalStatus.visual override (V7 §22.14/§22.17)", () => {
  it("readVisualManifest returns the parsed manifest when present", async () => {
    const id = "20260822-000050-glimmer-visual-manifest";
    const dir = path.join(contractStateRoot, "sessions", id, "visual");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "visual-manifest.json"), JSON.stringify(REAL_VISUAL_MANIFEST));
    expect(await sessionsIsolated.readVisualManifest(id)).toEqual(REAL_VISUAL_MANIFEST);
  });

  it("readVisualManifest/readVisualFindings return null when no visual/ dir exists (normal, opt-in)", async () => {
    const id = "20260822-000051-glimmer-no-visual";
    await fs.mkdir(path.join(contractStateRoot, "sessions", id), { recursive: true });
    expect(await sessionsIsolated.readVisualManifest(id)).toBeNull();
    expect(await sessionsIsolated.readVisualFindings(id)).toBeNull();
  });

  it("readSession upgrades finalStatus.visual from findings.json's real status", async () => {
    const id = "20260822-000052-glimmer-visual-findings";
    const dir = path.join(contractStateRoot, "sessions", id);
    const visualDir = path.join(dir, "visual");
    await fs.mkdir(visualDir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...REAL_MANIFEST, sessionId: id }));
    await fs.writeFile(path.join(visualDir, "visual-manifest.json"), JSON.stringify(REAL_VISUAL_MANIFEST));
    await fs.writeFile(
      path.join(visualDir, "findings.json"),
      JSON.stringify({ status: "PASS_WITH_WARNINGS", viewport: "multi", viewports: ["1440x900", "390x844"], findings: [] })
    );
    const session = await sessionsIsolated.readSession(id);
    expect(session?.finalStatus.visual).toBe("PASS_WITH_WARNINGS");
    // The other three legs are untouched by the visual override.
    expect(session?.finalStatus.functional).toBe("VERIFIED");
  });

  it("readSession falls back to not_run for an unrecognized findings.json status", async () => {
    const id = "20260822-000052b-glimmer-visual-bad-status";
    const dir = path.join(contractStateRoot, "sessions", id);
    const visualDir = path.join(dir, "visual");
    await fs.mkdir(visualDir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...REAL_MANIFEST, sessionId: id }));
    await fs.writeFile(path.join(visualDir, "visual-manifest.json"), JSON.stringify(REAL_VISUAL_MANIFEST));
    await fs.writeFile(
      path.join(visualDir, "findings.json"),
      JSON.stringify({ status: "SOMETHING_UNKNOWN", viewport: "multi", viewports: ["1440x900"], findings: [] })
    );
    const session = await sessionsIsolated.readSession(id);
    expect(session?.finalStatus.visual).toBe("not_run");
  });

  it("readSession leaves finalStatus.visual as not_run when no visual/ dir exists", async () => {
    const id = "20260822-000053-glimmer-no-visual-session";
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...REAL_MANIFEST, sessionId: id }));
    const session = await sessionsIsolated.readSession(id);
    expect(session?.finalStatus.visual).toBe("not_run");
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

// V7 §20 session-level verification freeze: verifiedAt/finalDiffHash
// pass-through + gateway-computed "stale" status.
//
// Review round 1 fix: staleness is NOT "workspace has uncommitted changes"
// -- glimmer-v2.py's collapse() (its `finally` block) resets HEAD back to
// baselineSha and DELIBERATELY leaves the produced diff sitting as
// uncommitted working-tree state (that's what View diff/accept read), so
// every successful-with-a-diff session is "dirty" at verifiedAt time BY
// CONSTRUCTION. Every fixture below therefore models production ordering
// explicitly: (1) commit baseline content, (2) leave an UNCOMMITTED diff in
// the workspace exactly as collapse() would, (3) compute finalDiffHash from
// THAT state via the real computeDiffHash() (same function git.test.ts's
// cross-language contract test proves matches Python byte-for-byte) --
// never a hand-picked/hardcoded hash. Staleness is then: does the CURRENT
// diff-against-baseline still hash to that same value.
describe("session-level verification freeze (V7 §20)", () => {
  const exec = promisify(execFile);
  let verifiedWorkspace: string;
  let baselineSha: string;

  // The exact uncommitted diff a real collapse() would have left: a.txt
  // changed from its committed "one\n" to "one\ntwo\n".
  const POST_VERIFY_CONTENT = "one\ntwo\n";

  const verifiedManifest = (finalDiffHash: string) => ({
    ...REAL_MANIFEST,
    status: "verified",
    verifiedAt: "2026-08-21T00:00:00.000Z",
    baseline: baselineSha,
    finalDiffHash,
    workspace: verifiedWorkspace,
  });

  async function writeSession(id: string, manifest: unknown) {
    const dir = path.join(contractStateRoot, "sessions", id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...(manifest as object), sessionId: id }));
  }

  beforeAll(async () => {
    verifiedWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-verified-ws-"));
    await exec("git", ["init", "-q"], { cwd: verifiedWorkspace });
    await exec("git", ["config", "user.email", "t@t.com"], { cwd: verifiedWorkspace });
    await exec("git", ["config", "user.name", "t"], { cwd: verifiedWorkspace });
    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "one\n");
    await exec("git", ["add", "a.txt"], { cwd: verifiedWorkspace });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: verifiedWorkspace });
    baselineSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: verifiedWorkspace })).stdout.trim();
  });

  afterAll(async () => {
    await fs.rm(verifiedWorkspace, { recursive: true, force: true });
  });

  it("parseManifest passes verifiedAt and finalDiffHash through when present, leaves both undefined otherwise", () => {
    const withIt = parseManifest(verifiedManifest("deadbeef"), "sid-verified-at");
    expect(withIt.verifiedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(withIt.finalDiffHash).toBe("deadbeef");
    const withoutIt = parseManifest(REAL_MANIFEST, "sid-no-verified-at");
    expect(withoutIt.verifiedAt).toBeUndefined();
    expect(withoutIt.finalDiffHash).toBeUndefined();
  });

  describe("with a real post-collapse uncommitted diff (production ordering)", () => {
    let finalDiffHash: string;

    beforeAll(async () => {
      // Model collapse()'s end state: HEAD stays at baselineSha, working
      // tree holds the uncommitted diff. finalDiffHash is fingerprinted from
      // exactly this state, same as glimmer-v2.py's `finally` block does.
      await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), POST_VERIFY_CONTENT);
      finalDiffHash = await computeDiffHash(verifiedWorkspace, baselineSha);
    });

    it("readSession without computeStale never touches git and reports plain verified", async () => {
      const id = "20260821-000060-glimmer-stale-no-opt";
      await writeSession(id, verifiedManifest(finalDiffHash));
      const session = await sessionsIsolated.readSession(id);
      expect(session?.status).toBe("verified");
    });

    it("readSession with computeStale reports plain verified when nothing changed since collapse", async () => {
      const id = "20260821-000061-glimmer-stale-unchanged";
      await writeSession(id, verifiedManifest(finalDiffHash));
      const session = await sessionsIsolated.readSession(id, { computeStale: true });
      expect(session?.status).toBe("verified");
    });

    it("readSession with computeStale reports stale once the workspace is modified again after collapse", async () => {
      await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "one\ntwo\nTHREE\n");
      const id = "20260821-000062-glimmer-stale-modified";
      await writeSession(id, verifiedManifest(finalDiffHash));

      const session = await sessionsIsolated.readSession(id, { computeStale: true });
      expect(session?.status).toBe("stale");
      // V7 §22.17: the gate object must agree with §20 staleness -- a stale
      // session's finalStatus.functional must not still read VERIFIED.
      expect(session?.finalStatus.functional).toBe("NEEDS_REVIEW");
    });

    it("readSession with computeStale is NOT stale again once content is restored EXACTLY (hash equality, not mtime)", async () => {
      // Rewriting the identical bytes gives this file a fresh mtime/inode
      // timestamp -- if staleness were mtime-based this would still read
      // stale. It must not: content hash equality is what matters.
      await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), POST_VERIFY_CONTENT);
      const id = "20260821-000063-glimmer-stale-restored";
      await writeSession(id, verifiedManifest(finalDiffHash));

      const session = await sessionsIsolated.readSession(id, { computeStale: true });
      expect(session?.status).toBe("verified");
    });

    it("readSession with computeStale detects a NEW untracked file as a hash change too", async () => {
      await fs.writeFile(path.join(verifiedWorkspace, "untracked-after-verify.txt"), "surprise\n");
      const id = "20260821-000064-glimmer-stale-untracked";
      await writeSession(id, verifiedManifest(finalDiffHash));

      const session = await sessionsIsolated.readSession(id, { computeStale: true });
      expect(session?.status).toBe("stale");

      await fs.rm(path.join(verifiedWorkspace, "untracked-after-verify.txt"));
    });

    afterAll(async () => {
      // Restore to the fixture's baseline post-collapse state for any
      // later test in this file that might reuse verifiedWorkspace.
      await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), POST_VERIFY_CONTENT);
    });
  });

  it("readSession with computeStale is NOT stale when finalDiffHash is absent (older manifest)", async () => {
    const id = "20260821-000065-glimmer-stale-no-hash";
    const { finalDiffHash: _omit, ...manifestWithoutHash } = verifiedManifest("irrelevant");
    await writeSession(id, manifestWithoutHash);

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("verified");
  });

  it("readSession with computeStale is NOT stale when the workspace directory no longer exists", async () => {
    const goneWorkspace = path.join(os.tmpdir(), "glimmer-workspace-that-never-existed-" + Date.now());
    const id = "20260821-000066-glimmer-stale-workspace-gone";
    await writeSession(id, { ...verifiedManifest("irrelevant"), workspace: goneWorkspace });

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("verified");
  });

  it("readSession with computeStale never flips a non-verified status to stale even with a hash mismatch", async () => {
    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), "totally different content\n");
    const id = "20260821-000067-glimmer-stale-not-verified";
    await writeSession(id, {
      ...verifiedManifest("some-hash-that-will-never-match"),
      status: "no-change-unverified",
      verifiedAt: undefined,
    });

    const session = await sessionsIsolated.readSession(id, { computeStale: true });
    expect(session?.status).toBe("needs_review");

    await fs.writeFile(path.join(verifiedWorkspace, "a.txt"), POST_VERIFY_CONTENT);
  });
});

// Task 4.3 review round 1 (Important 3 + Moderate 5): applyTaskOverrides is
// a pure display transform, unit-tested directly here rather than only
// through the HTTP routes (server/src/routes/sessions.test.ts covers the
// route/merge integration).
describe("applyTaskOverrides (Task 4.3, review round 1: id-stability + fail-open)", () => {
  const task: GlimmerTask = {
    id: "t1", description: "Add hook", kind: "implementation", dependsOn: [], status: "pending", priority: "required",
  };

  it("applies skip/approve when the override's captured kind+description match the current task", () => {
    const [skipped] = applyTaskOverrides([task], {
      t1: { action: "skip", at: "2026-01-01T00:00:00Z", kind: "implementation", description: "Add hook" },
    });
    expect(skipped).toMatchObject({ status: "skipped", priority: "optional" });
    expect(skipped.override).toMatchObject({ action: "skip" });
    expect(skipped.staleOverride).toBeUndefined();

    const [approved] = applyTaskOverrides([task], {
      t1: { action: "approve", at: "2026-01-01T00:00:00Z", kind: "implementation", description: "Add hook" },
    });
    expect(approved).toMatchObject({ status: "complete" });
    expect(approved.override).toMatchObject({ action: "approve" });
  });

  it("trusts the id alone for a legacy override with no kind/description captured", () => {
    const [t] = applyTaskOverrides([task], { t1: { action: "skip", at: "2026-01-01T00:00:00Z" } });
    expect(t).toMatchObject({ status: "skipped" });
    expect(t.staleOverride).toBeUndefined();
  });

  it("ignores a stale override whose id was recycled by a replan (kind/description no longer match)", () => {
    // Same id "t1", but this override was recorded for a DIFFERENT task
    // that used to hold id t1 before a replan renumbered the task list.
    const [t] = applyTaskOverrides([task], {
      t1: { action: "skip", at: "2026-01-01T00:00:00Z", kind: "verification", description: "Run the old tests" },
    });
    expect(t.status).toBe("pending"); // unchanged -- override NOT applied
    expect(t.override).toBeUndefined();
    expect(t.staleOverride).toMatchObject({ action: "skip" });
  });

  it("fails open on an unrecognized override action -- returns the task unchanged", () => {
    const [t] = applyTaskOverrides([task], {
      // @ts-expect-error -- deliberately an invalid action, proving the runtime fail-open path
      t1: { action: "bogus", at: "2026-01-01T00:00:00Z" },
    });
    expect(t).toEqual(task);
  });

  it("returns tasks unchanged when overrides is null", () => {
    expect(applyTaskOverrides([task], null)).toEqual([task]);
  });
});
