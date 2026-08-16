import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseManifest, isValidSessionId, readManifestRaw, readSession, mapManifestStatus,
  writeGatewayContract, readGatewayContract,
} from "./sessions.js";
import { sessionsDir } from "../config.js";
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

const GATEWAY_CONTRACT_TEST_DIRS = [
  "20260817-000000-glimmer-test",
  "20260817-000001-glimmer-nocontract",
  "20260817-000002-glimmer-withcontract",
];

afterAll(async () => {
  // ponytail: these tests write into the real sessionsDir() (no
  // GLIMMER_STATE_ROOT override in this file) — clean up after ourselves so
  // repeated runs don't litter ~/.muse-glimmer/sessions.
  await Promise.all(
    GATEWAY_CONTRACT_TEST_DIRS.map((id) => fs.rm(path.join(sessionsDir(), id), { recursive: true, force: true }))
  );
});

describe("gateway contract persistence", () => {
  it("round-trips a written contract", async () => {
    const dir = path.join(sessionsDir(), "20260817-000000-glimmer-test");
    await fs.mkdir(dir, { recursive: true });
    await writeGatewayContract(dir, REAL_CONTRACT);
    const read = await readGatewayContract("20260817-000000-glimmer-test");
    expect(read).toEqual(REAL_CONTRACT);
  });

  it("returns null when no contract was ever written for a session", async () => {
    const dir = path.join(sessionsDir(), "20260817-000001-glimmer-nocontract");
    await fs.mkdir(dir, { recursive: true });
    expect(await readGatewayContract("20260817-000001-glimmer-nocontract")).toBeNull();
  });
});

describe("readSession populates taskContract", () => {
  it("attaches the persisted contract to the returned GlimmerSession", async () => {
    const id = "20260817-000002-glimmer-withcontract";
    const dir = path.join(sessionsDir(), id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...REAL_MANIFEST, sessionId: id }));
    await writeGatewayContract(dir, REAL_CONTRACT);
    const session = await readSession(id);
    expect(session?.taskContract).toEqual(REAL_CONTRACT);
  });
});
