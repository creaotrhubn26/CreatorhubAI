import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";

const UI_ORIGIN = "http://127.0.0.1:5183";

let app: Express;
let stateRoot: string;

beforeEach(async () => {
  vi.resetModules();
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-model-registry-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_MODEL_CONFIG = path.join(stateRoot, "models.json");
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:8080";
  const module = await import("../app.js");
  app = module.createApp();
});

afterEach(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  delete process.env.GLIMMER_STATE_ROOT;
  delete process.env.GLIMMER_MODEL_URL;
  delete process.env.GLIMMER_MODEL_CONFIG;
});

const roles = {
  engineer: "local",
  architect: "frontier",
  consult: "frontier",
  vision: "local",
} as const;

function registryUpdate(apiKey?: string) {
  return {
    models: [
      { id: "local", label: "Local", baseUrl: "http://127.0.0.1:8080", modelId: "local-model" },
      {
        id: "frontier",
        label: "Frontier",
        baseUrl: "https://models.example.test/v1",
        modelId: "frontier-model",
        ...(apiKey ? { apiKey } : {}),
      },
    ],
    roles,
  };
}

describe("model registry API", () => {
  it("returns a usable secret-free default", async () => {
    const res = await request(app).get("/api/models/config");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("default");
    expect(res.body.models).toHaveLength(1);
    expect(res.body.roles).toEqual({
      engineer: "local",
      architect: "local",
      consult: "local",
      vision: "local",
    });
    expect(JSON.stringify(res.body)).not.toContain("apiKeyFile");
    expect(res.body.models[0]).toHaveProperty("hasApiKey");
  });

  it("stores API keys in mode-0600 files and never returns or embeds them", async () => {
    const secret = "super-secret-token";
    const saved = await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(registryUpdate(secret));

    expect(saved.status).toBe(200);
    expect(saved.body.source).toBe("saved");
    expect(saved.body.roles).toEqual(roles);
    expect(saved.body.models.find((model: any) => model.id === "frontier").hasApiKey).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    expect(JSON.stringify(saved.body)).not.toContain("apiKeyFile");

    const storedText = await fs.readFile(path.join(stateRoot, "models.json"), "utf8");
    const stored = JSON.parse(storedText);
    const keyFile = stored.models.find((model: any) => model.id === "frontier").apiKeyFile;
    expect(storedText).not.toContain(secret);
    expect(path.dirname(keyFile)).toBe(path.join(stateRoot, "model-keys"));
    expect(path.basename(keyFile)).toMatch(/^[a-f0-9]{24}\.key$/);
    expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(keyFile, "utf8")).trim()).toBe(secret);

    const readBack = await request(app).get("/api/models/config");
    expect(readBack.status).toBe(200);
    expect(JSON.stringify(readBack.body)).not.toContain(secret);
    expect(JSON.stringify(readBack.body)).not.toContain(keyFile);
  });

  it("preserves a stored key when the update leaves the key blank", async () => {
    await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(registryUpdate("first-key"));

    const saved = await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(registryUpdate());

    expect(saved.status).toBe(200);
    expect(saved.body.models.find((model: any) => model.id === "frontier").hasApiKey).toBe(true);
    const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "models.json"), "utf8"));
    expect((await fs.readFile(stored.models[1].apiKeyFile, "utf8")).trim()).toBe("first-key");
  });

  it("stores adaptive high-risk and independent-critic routing additively", async () => {
    const update = {
      ...registryUpdate(),
      routing: {
        enabled: true,
        highRisk: { engineer: "frontier" },
        criticProviderId: "local",
        requireIndependentCritic: true,
      },
    };
    const saved = await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(update);
    expect(saved.status).toBe(200);
    expect(saved.body.routing).toEqual(update.routing);
    const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "models.json"), "utf8"));
    expect(stored.routing).toEqual(update.routing);

    const invalid = { ...update, routing: { ...update.routing, criticProviderId: "missing" } };
    expect(
      (await request(app).put("/api/models/config").set("Origin", UI_ORIGIN).send(invalid)).status,
    ).toBe(400);
  });

  it("clears only the gateway-owned key file when requested", async () => {
    await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(registryUpdate("remove-me"));
    const update = registryUpdate() as any;
    update.models[1].clearApiKey = true;

    const saved = await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(update);

    expect(saved.status).toBe(200);
    expect(saved.body.models.find((model: any) => model.id === "frontier").hasApiKey).toBe(false);
    expect(await fs.readdir(path.join(stateRoot, "model-keys"))).toEqual([]);
  });

  it("detaches but never deletes a manually managed key path", async () => {
    const manualKey = path.join(stateRoot, "manually-managed.key");
    await fs.writeFile(manualKey, "keep-me\n", { mode: 0o600 });
    await fs.writeFile(
      path.join(stateRoot, "models.json"),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "local",
            label: "Local",
            baseUrl: "http://127.0.0.1:8080",
            modelId: "local-model",
            apiKeyFile: manualKey,
          },
        ],
        roles: { engineer: "local", architect: "local", consult: "local", vision: "local" },
      }),
    );

    const update = {
      models: [
        {
          id: "local",
          label: "Local",
          baseUrl: "http://127.0.0.1:8080",
          modelId: "local-model",
          clearApiKey: true,
        },
      ],
      roles: { engineer: "local", architect: "local", consult: "local", vision: "local" },
    };
    const saved = await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(update);

    expect(saved.status).toBe(200);
    expect(saved.body.models[0].hasApiKey).toBe(false);
    expect(await fs.readFile(manualKey, "utf8")).toBe("keep-me\n");
  });

  it("keeps case-distinct registry ids in distinct key files on macOS", async () => {
    const update = {
      models: [
        {
          id: "Cloud",
          label: "Upper",
          baseUrl: "https://upper.example.test/v1",
          modelId: "upper",
          apiKey: "upper-key",
        },
        {
          id: "cloud",
          label: "Lower",
          baseUrl: "https://lower.example.test/v1",
          modelId: "lower",
          apiKey: "lower-key",
        },
      ],
      roles: { engineer: "Cloud", architect: "cloud", consult: "Cloud", vision: "cloud" },
    };
    const saved = await request(app)
      .put("/api/models/config")
      .set("Origin", UI_ORIGIN)
      .send(update);
    expect(saved.status).toBe(200);

    const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "models.json"), "utf8"));
    const [upperPath, lowerPath] = stored.models.map((model: any) => model.apiKeyFile);
    expect(upperPath).not.toBe(lowerPath);
    expect((await fs.readFile(upperPath, "utf8")).trim()).toBe("upper-key");
    expect((await fs.readFile(lowerPath, "utf8")).trim()).toBe("lower-key");
  });

  it("rejects duplicate ids, unsafe URLs, and roles that reference unknown models", async () => {
    const duplicate = registryUpdate();
    duplicate.models[1].id = "local";
    expect(
      (await request(app).put("/api/models/config").set("Origin", UI_ORIGIN).send(duplicate))
        .status,
    ).toBe(400);

    const unsafe = registryUpdate();
    unsafe.models[1].baseUrl = "https://user:pass@models.example.test/v1";
    expect(
      (await request(app).put("/api/models/config").set("Origin", UI_ORIGIN).send(unsafe)).status,
    ).toBe(400);

    const unknownRole = registryUpdate() as any;
    unknownRole.roles.architect = "missing";
    expect(
      (await request(app).put("/api/models/config").set("Origin", UI_ORIGIN).send(unknownRole))
        .status,
    ).toBe(400);
    await expect(fs.stat(path.join(stateRoot, "models.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
