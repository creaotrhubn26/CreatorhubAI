import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let app: Express;
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-design-catalog-routes-"));
  const hash = createHash("sha256").update("design").digest("hex");
  const profile = {
    id: "editorial",
    title: "Editorial",
    description: "Calm editorial publication",
    version: "0.1.0",
    license: "MIT",
    category: "Editorial & Publishing",
    profileType: "visual-archetype",
    platforms: ["web"],
    productKinds: ["editorial"],
    tags: ["design-system"],
    characteristics: {
      tones: ["calm", "editorial"],
      density: "balanced",
      contrast: "medium",
      geometry: "neutral",
      elevation: "subtle",
      modes: ["light"],
      motion: "moderate",
    },
    typography: {
      primary: "Inter",
      display: "Georgia",
      mono: "",
      proprietary: false,
      substitutes: [],
    },
    colors: { primary: "#8B5E3C", surface: "#FAF7F2", text: "#17181A" },
    components: ["cards"],
    layouts: ["editorial"],
    quality: {
      completeness: 90,
      richness: 80,
      overall: 87,
      evidence: "curated",
      referenceRisk: "low",
    },
    selection: {
      adopt: ["calm hierarchy"],
      verify: ["repository tokens"],
      avoid: ["literal copying"],
    },
    sha256: { design: hash, manifest: hash },
    searchText: "editorial calm publication serif",
  };
  const catalogPath = path.join(root, "catalog.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      schemaVersion: 2,
      generatedAt: "2026-08-29T00:00:00Z",
      count: 1,
      facets: {},
      profiles: [profile],
    }),
  );
  process.env.GLIMMER_STATE_ROOT = path.join(root, "state");
  process.env.GLIMMER_DESIGN_CATALOG_PATH = catalogPath;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1";
  vi.resetModules();
  app = (await import("../app.js")).createApp();
});

afterAll(async () => {
  delete process.env.GLIMMER_STATE_ROOT;
  delete process.env.GLIMMER_DESIGN_CATALOG_PATH;
  delete process.env.GLIMMER_MODEL_URL;
  await fs.rm(root, { recursive: true, force: true });
});

describe("design catalogue routes", () => {
  it("serves bounded facets, intent search, and inert previews", async () => {
    const facets = await request(app).get("/api/design-catalog/facets");
    expect(facets.status).toBe(200);
    expect(facets.body).toMatchObject({ schemaVersion: 2, count: 1 });
    const search = await request(app)
      .post("/api/design-catalog/search")
      .set("Origin", "http://127.0.0.1:5183")
      .send({ query: "calm editorial" });
    expect(search.status).toBe(200);
    expect(search.body.results[0]).toMatchObject({ id: "editorial" });
    const preview = await request(app).get("/api/design-catalog/profiles/editorial/preview.svg");
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(Buffer.from(preview.body).toString("utf8")).not.toMatch(/<script|javascript:/i);
  });

  it("persists custom profiles and rejects open-ended search fields", async () => {
    const invalid = await request(app)
      .post("/api/design-catalog/search")
      .set("Origin", "http://127.0.0.1:5183")
      .send({ query: "editorial", command: "run" });
    expect(invalid.status).toBe(400);
    const created = await request(app)
      .post("/api/design-catalog/custom")
      .set("Origin", "http://127.0.0.1:5183")
      .send({
        title: "Warm workspace",
        description: "Custom direction",
        category: "Custom",
        tones: ["warm"],
        colors: { primary: "#C96442", surface: "#F5F4ED" },
        adopt: ["warm hierarchy"],
        avoid: ["brand imitation"],
      });
    expect(created.status).toBe(201);
    expect(created.body.customProfiles[0]).toMatchObject({
      source: "custom",
      title: "Warm workspace",
    });
    const library = await request(app).get("/api/design-catalog/library");
    expect(library.body.customProfiles).toHaveLength(1);
  });
});
