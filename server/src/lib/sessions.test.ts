import { describe, it, expect } from "vitest";
import { parseManifest } from "./sessions";

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
