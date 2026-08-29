import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

let app: Express;
let stateRoot: string;
let orchestratorRoot: string;

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-quality-state-"));
  orchestratorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-quality-orchestrator-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_V2_PATH = path.join(orchestratorRoot, "glimmer-v2.py");
  const { createApp } = await import("../app.js");
  app = createApp();
});

afterAll(async () => {
  delete process.env.GLIMMER_STATE_ROOT;
  delete process.env.GLIMMER_V2_PATH;
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(orchestratorRoot, { recursive: true, force: true });
});

describe("GET /api/quality/metrics", () => {
  it("returns local aggregates without exposing report text or source code", async () => {
    const session = path.join(stateRoot, "sessions", "quality-fixture");
    await fs.mkdir(session, { recursive: true });
    await fs.writeFile(
      path.join(session, "task-report.json"),
      JSON.stringify({
        schemaVersion: 2,
        findings: [
          { verification: { status: "verified" }, description: "private report text" },
          { verification: { status: "partial" } },
        ],
        rejectedFindings: [{ verification: { status: "rejected" } }],
      }),
    );
    await fs.writeFile(
      path.join(session, "repo-index.json"),
      JSON.stringify({ schemaVersion: 1, coverage: { ratio: 0.75 }, files: ["secret.ts"] }),
    );
    await fs.writeFile(
      path.join(session, "events.jsonl"),
      `${JSON.stringify({
        type: "model_routing_decision",
        reason: "high-risk-override",
        criticIndependence: "independent",
      })}\n`,
    );
    await fs.mkdir(path.join(orchestratorRoot, "eval-baselines"), { recursive: true });
    await fs.writeFile(
      path.join(orchestratorRoot, "eval-baselines", "latest-stub.json"),
      JSON.stringify({ mode: "stub", candidateRecallAt5: 0.93 }),
    );

    const response = await request(app).get("/api/quality/metrics");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reports: 1,
      verifiedClaims: 1,
      partialClaims: 1,
      rejectedClaims: 1,
      claimPrecision: 0.3333,
      averageGraphCoverage: 0.75,
      candidateRecallAt5: 0.93,
      routing: {
        decisions: 1,
        highRiskOverrides: 1,
        criticIndependence: { independent: 1, "same-model": 0, unavailable: 0 },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private report text");
    expect(JSON.stringify(response.body)).not.toContain("secret.ts");
  });
});
