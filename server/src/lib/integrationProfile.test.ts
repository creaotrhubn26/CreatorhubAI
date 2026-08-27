import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyIntegrationProfile,
  previewIntegrationProfile,
  rollbackIntegrationProfile,
} from "./integrationProfile.js";

let root: string;
let home: string;
let source: string;
let backups: string;

async function writePluginManifest(rootPath: string, folder: string, version: string) {
  await fs.mkdir(path.join(rootPath, folder), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, folder, "plugin.json"),
    JSON.stringify({ name: "creatorhub-engineering", version }),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-integration-profile-"));
  home = path.join(root, "home");
  source = path.join(root, "source");
  backups = path.join(root, "backups");
  await writePluginManifest(source, ".codex-plugin", "0.3.1");
  await writePluginManifest(source, ".claude-plugin", "0.3.1");
  await fs.mkdir(path.join(source, "glimmer", "skills"), { recursive: true });
  await fs.writeFile(
    path.join(source, "glimmer", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "creatorhub-engineering",
      version: "0.3.1",
      skills: ["00-core.md"],
    }),
  );
  await fs.writeFile(
    path.join(source, "glimmer", "skills", "00-core.md"),
    "---\nname: core\nareas: repository\n---\nUse evidence.\n",
  );

  const claude = path.join(home, ".claude", "skills", "creatorhub-engineering");
  await writePluginManifest(claude, ".claude-plugin", "0.2.9");
  await fs.writeFile(path.join(claude, "old.txt"), "old claude\n");
  const glimmer = path.join(home, ".muse-glimmer", "skills");
  await fs.mkdir(glimmer, { recursive: true });
  await fs.writeFile(path.join(glimmer, "00-core.md"), "old glimmer\n");
  await fs.writeFile(
    path.join(glimmer, ".creatorhub-engineering.json"),
    JSON.stringify({ name: "creatorhub-engineering", version: "0.2.9", files: ["00-core.md"] }),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("CreatorHub integration profile", () => {
  it("previews drift, applies from the fixed local source, and restores the backup", async () => {
    const options = { homeDirectory: home, sourceRoot: source, backupRoot: backups };
    const preview = await previewIntegrationProfile(options);
    expect(preview.desiredVersion).toBe("0.3.1");
    expect(preview.targets.map((target) => [target.id, target.state])).toEqual([
      ["codex", "in_sync"],
      ["claude", "drift"],
      ["glimmer", "drift"],
    ]);

    const applied = await applyIntegrationProfile("0.3.1", options);
    expect(applied.appliedTargets).toEqual(["claude", "glimmer"]);
    expect(applied.backupId).toMatch(/^\d{8}T\d{6}-[a-f0-9]{8}$/);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(
            home,
            ".claude",
            "skills",
            "creatorhub-engineering",
            ".claude-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      ).version,
    ).toBe("0.3.1");
    expect(
      await fs.readFile(path.join(home, ".muse-glimmer", "skills", "00-core.md"), "utf8"),
    ).toContain("Use evidence");

    const rolledBack = await rollbackIntegrationProfile(applied.backupId!, options);
    expect(rolledBack.rolledBack).toBe(true);
    expect(
      await fs.readFile(
        path.join(home, ".claude", "skills", "creatorhub-engineering", "old.txt"),
        "utf8",
      ),
    ).toBe("old claude\n");
    expect(
      await fs.readFile(path.join(home, ".muse-glimmer", "skills", "00-core.md"), "utf8"),
    ).toBe("old glimmer\n");
  });

  it("refuses a stale preview version before changing a target", async () => {
    const options = { homeDirectory: home, sourceRoot: source, backupRoot: backups };
    await expect(applyIntegrationProfile("0.3.0", options)).rejects.toThrow("preview is stale");
    expect(
      await fs.readFile(
        path.join(home, ".claude", "skills", "creatorhub-engineering", "old.txt"),
        "utf8",
      ),
    ).toBe("old claude\n");
  });

  it("rejects a tampered rollback manifest before touching files outside the profile", async () => {
    const options = { homeDirectory: home, sourceRoot: source, backupRoot: backups };
    const applied = await applyIntegrationProfile("0.3.1", options);
    const backup = path.join(backups, applied.backupId!);
    const manifestFile = path.join(backup, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.glimmerExistingFiles = ["../../outside.md"];
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const outside = path.join(home, "outside.md");
    await fs.writeFile(outside, "do not touch\n");

    await expect(rollbackIntegrationProfile(applied.backupId!, options)).rejects.toThrow(
      "unavailable",
    );
    expect(await fs.readFile(outside, "utf8")).toBe("do not touch\n");
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(
            home,
            ".claude",
            "skills",
            "creatorhub-engineering",
            ".claude-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      ).version,
    ).toBe("0.3.1");
  });
});
