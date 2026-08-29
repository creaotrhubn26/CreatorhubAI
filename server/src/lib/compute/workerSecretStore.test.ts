import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../../config.js";
import {
  createWorkerSecret,
  deleteWorkerSecret,
  readWorkerSecret,
  storeWorkerHandshake,
} from "./workerSecretStore.js";

describe("workerSecretStore", () => {
  let temporary = "";
  let original = "";

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-worker-secrets-"));
    original = CONFIG.computeWorkerKeysDir;
    (CONFIG as { computeWorkerKeysDir: string }).computeWorkerKeysDir = temporary;
  });

  afterEach(async () => {
    (CONFIG as { computeWorkerKeysDir: string }).computeWorkerKeysDir = original;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("stores gateway-owned secrets mode 0600 and removes bootstrap after rotation", async () => {
    const created = await createWorkerSecret("lease-1");
    expect(created.bootstrapToken).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    const target = path.join(temporary, "lease-1.json");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);

    const rotated = await storeWorkerHandshake("lease-1", "C".repeat(43), "K".repeat(43));
    expect(rotated.bootstrapToken).toBeUndefined();
    expect(rotated.capability).toBe("C".repeat(43));
    const stored = await fs.readFile(target, "utf8");
    expect(stored).not.toContain(created.bootstrapToken!);
    expect(await readWorkerSecret("lease-1")).toEqual(rotated);

    await deleteWorkerSecret("lease-1");
    await expect(readWorkerSecret("lease-1")).resolves.toBeNull();
  });

  it("rejects traversal ids before touching the filesystem", async () => {
    await expect(createWorkerSecret("../escape")).rejects.toThrow(/lease id is invalid/);
    expect(await fs.readdir(temporary)).toEqual([]);
  });
});
