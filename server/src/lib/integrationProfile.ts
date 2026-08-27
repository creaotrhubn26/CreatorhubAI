import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IntegrationProfileApplyResult,
  IntegrationProfilePreview,
  IntegrationProfileRollbackResult,
  IntegrationProfileTargetId,
  IntegrationProfileTargetState,
} from "@glimmer/shared";
import { recoveryBackupsDir } from "../config.js";

const PROFILE = "creatorhub-engineering";
const SAFE_BACKUP_ID = /^\d{8}T\d{6}-[a-f0-9]{8}$/;
const MAX_PLUGIN_FILES = 512;
const MAX_PLUGIN_BYTES = 16 * 1024 * 1024;

interface ProfileOptions {
  homeDirectory?: string;
  sourceRoot?: string;
  backupRoot?: string;
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
}

interface GlimmerManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  skills: string[];
}

interface BackupManifest {
  version: 1;
  backupId: string;
  createdAt: string;
  sourceVersion: string;
  claudeExisted: boolean;
  claudeChanged: boolean;
  glimmerChanged: boolean;
  glimmerExistingFiles: string[];
  glimmerMissingFiles: string[];
  rolledBackAt?: string;
}

function versionParts(value: string): [number, number, number, string] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  }
  // A stable release sorts after a pre-release with the same numeric version.
  if (!a[3] && b[3]) return 1;
  if (a[3] && !b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

function locations(options: ProfileOptions = {}) {
  const home = options.homeDirectory ?? os.homedir();
  return {
    home,
    codexVersions: path.join(home, ".codex", "plugins", "cache", "personal", PROFILE),
    claude: path.join(home, ".claude", "skills", PROFILE),
    glimmer: path.join(home, ".muse-glimmer", "skills"),
    backups: options.backupRoot ?? path.join(recoveryBackupsDir(), "integration-profile"),
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error: any) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

async function pluginVersion(root: string, manifest: ".codex-plugin" | ".claude-plugin") {
  const parsed = await readJson<PluginManifest>(path.join(root, manifest, "plugin.json"));
  return parsed?.name === PROFILE && typeof parsed.version === "string" ? parsed.version : null;
}

async function findSource(options: ProfileOptions): Promise<string | null> {
  if (options.sourceRoot) return options.sourceRoot;
  const root = locations(options).codexVersions;
  const versions = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return (
    versions
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(entry.name))
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => compareVersions(path.basename(left), path.basename(right)))
      .reverse()[0] ?? null
  );
}

async function readGlimmerManifest(source: string): Promise<GlimmerManifest> {
  const manifest = await readJson<GlimmerManifest>(path.join(source, "glimmer", "manifest.json"));
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.name !== PROFILE ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.length === 0 ||
    manifest.skills.some(
      (file) => typeof file !== "string" || path.basename(file) !== file || !file.endsWith(".md"),
    )
  ) {
    throw new Error("CreatorHub Engineering has an invalid Glimmer adapter manifest.");
  }
  return manifest;
}

async function validatePluginTree(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error("Plugin source contains a symbolic link.");
      if (stat.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!stat.isFile()) throw new Error("Plugin source contains an unsupported file type.");
      files += 1;
      bytes += stat.size;
      if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) {
        throw new Error("Plugin source exceeds the safe copy limit.");
      }
    }
  }
  await walk(root);
}

async function rejectSymlink(file: string, allowMissing = true): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink())
      throw new Error(`Refusing symbolic-link integration target: ${file}`);
  } catch (error: any) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
}

function isManagedGlimmerFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    path.basename(value) === value &&
    (value === ".creatorhub-engineering.json" || value.endsWith(".md"))
  );
}

function parseBackupManifest(value: unknown, id: string): BackupManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Partial<BackupManifest>;
  const existing = manifest.glimmerExistingFiles;
  const missing = manifest.glimmerMissingFiles;
  if (
    manifest.version !== 1 ||
    manifest.backupId !== id ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.sourceVersion !== "string" ||
    typeof manifest.claudeExisted !== "boolean" ||
    typeof manifest.claudeChanged !== "boolean" ||
    typeof manifest.glimmerChanged !== "boolean" ||
    !Array.isArray(existing) ||
    !Array.isArray(missing) ||
    existing.length + missing.length > MAX_PLUGIN_FILES ||
    !existing.every(isManagedGlimmerFile) ||
    !missing.every(isManagedGlimmerFile) ||
    new Set([...existing, ...missing]).size !== existing.length + missing.length ||
    (manifest.rolledBackAt !== undefined && typeof manifest.rolledBackAt !== "string")
  ) {
    return null;
  }
  return manifest as BackupManifest;
}

async function latestRollbackId(root: string): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() && SAFE_BACKUP_ID.test(candidate.name))
    .sort((a, b) => b.name.localeCompare(a.name))) {
    const manifest = await readJson<BackupManifest>(path.join(root, entry.name, "manifest.json"));
    if (manifest && !manifest.rolledBackAt) return entry.name;
  }
  return undefined;
}

export async function previewIntegrationProfile(
  options: ProfileOptions = {},
): Promise<IntegrationProfilePreview> {
  const paths = locations(options);
  const source = await findSource(options);
  const desiredVersion = source ? await pluginVersion(source, ".codex-plugin") : null;
  const claudeVersion = await pluginVersion(paths.claude, ".claude-plugin");
  const glimmerRecord = await readJson<{ name?: unknown; version?: unknown }>(
    path.join(paths.glimmer, ".creatorhub-engineering.json"),
  );
  const glimmerVersion =
    glimmerRecord?.name === PROFILE && typeof glimmerRecord.version === "string"
      ? glimmerRecord.version
      : null;
  const state = (current: string | null): IntegrationProfileTargetState =>
    !current ? "missing" : desiredVersion && current === desiredVersion ? "in_sync" : "drift";
  const target = (
    id: IntegrationProfileTargetId,
    name: string,
    current: string | null,
    targetPath: string,
  ) => ({
    id,
    name,
    state: state(current),
    ...(current ? { currentVersion: current } : {}),
    ...(desiredVersion ? { desiredVersion } : {}),
    path: targetPath,
    action:
      state(current) === "in_sync"
        ? "No change."
        : desiredVersion
          ? `Back up the current target, then install ${desiredVersion} from the local Codex plugin cache.`
          : "Install the CreatorHub Engineering plugin in Codex first.",
  });
  const targets = [
    target("codex", "Codex plugin", desiredVersion, source ?? paths.codexVersions),
    target("claude", "Claude local skills", claudeVersion, paths.claude),
    target("glimmer", "Glimmer skill adapter", glimmerVersion, paths.glimmer),
  ];
  return {
    profile: PROFILE,
    checkedAt: new Date().toISOString(),
    desiredVersion,
    ...(source ? { sourcePath: source } : {}),
    canApply: Boolean(source && desiredVersion && targets.some((item) => item.state !== "in_sync")),
    ...(await latestRollbackId(paths.backups).then((id) => (id ? { latestRollbackId: id } : {}))),
    targets,
    policy: {
      previewRequired: true,
      backupBeforeApply: true,
      credentialsInspected: false,
      arbitraryCommandsExecuted: false,
    },
  };
}

function backupId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
}

async function atomicText(target: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode });
  await fs.rename(temporary, target);
  await fs.chmod(target, mode);
}

async function validateGlimmerSkill(source: string): Promise<string> {
  const text = await fs.readFile(source, "utf8");
  const lines = text.split(/\r?\n/);
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (lines[0]?.trim() !== "---" || closing < 0)
    throw new Error("Invalid Glimmer skill frontmatter.");
  const body = lines
    .slice(closing + 2)
    .join("\n")
    .trim();
  if (!body || Buffer.byteLength(body) > 1536) throw new Error("Invalid Glimmer skill body.");
  return text;
}

export async function applyIntegrationProfile(
  expectedVersion: string,
  options: ProfileOptions = {},
): Promise<IntegrationProfileApplyResult> {
  const before = await previewIntegrationProfile(options);
  if (!before.sourcePath || !before.desiredVersion)
    throw new Error("Codex plugin source is missing.");
  if (before.desiredVersion !== expectedVersion) {
    throw new Error("Integration preview is stale; refresh it before applying.");
  }
  if (!before.canApply) return { backupId: null, appliedTargets: [], preview: before };
  await validatePluginTree(before.sourcePath);
  const glimmerManifest = await readGlimmerManifest(before.sourcePath);
  if (glimmerManifest.version !== before.desiredVersion) {
    throw new Error("Codex and Glimmer plugin versions do not agree.");
  }
  const glimmerSkillContents = new Map<string, string>();
  for (const file of glimmerManifest.skills) {
    glimmerSkillContents.set(
      file,
      await validateGlimmerSkill(path.join(before.sourcePath, "glimmer", "skills", file)),
    );
  }

  const paths = locations(options);
  await Promise.all([rejectSymlink(paths.claude), rejectSymlink(paths.glimmer)]);
  const id = backupId();
  const backup = path.join(paths.backups, id);
  await fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });
  await fs.mkdir(backup, { mode: 0o700 });
  const previousGlimmer = await readJson<{ files?: unknown }>(
    path.join(paths.glimmer, ".creatorhub-engineering.json"),
  );
  const glimmerCandidates = [
    ...new Set([
      ...glimmerManifest.skills,
      ...(Array.isArray(previousGlimmer?.files)
        ? previousGlimmer.files.filter(isManagedGlimmerFile)
        : []),
      ".creatorhub-engineering.json",
    ]),
  ].filter((file) => path.basename(file) === file);
  const existing: string[] = [];
  const missing: string[] = [];
  await fs.mkdir(path.join(backup, "glimmer"), { recursive: true, mode: 0o700 });
  for (const file of glimmerCandidates) {
    await rejectSymlink(path.join(paths.glimmer, file));
    try {
      await fs.copyFile(path.join(paths.glimmer, file), path.join(backup, "glimmer", file));
      existing.push(file);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(file);
    }
  }
  const claudeExisted = await fs
    .stat(paths.claude)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  const claudeChanged = before.targets.find((item) => item.id === "claude")?.state !== "in_sync";
  const glimmerChanged = before.targets.find((item) => item.id === "glimmer")?.state !== "in_sync";
  const manifest: BackupManifest = {
    version: 1,
    backupId: id,
    createdAt: new Date().toISOString(),
    sourceVersion: before.desiredVersion,
    claudeExisted,
    claudeChanged,
    glimmerChanged,
    glimmerExistingFiles: existing,
    glimmerMissingFiles: missing,
  };
  await atomicText(path.join(backup, "manifest.json"), JSON.stringify(manifest, null, 2), 0o600);

  const appliedTargets: IntegrationProfileTargetId[] = [];
  if (claudeChanged) {
    const staging = path.join(path.dirname(paths.claude), `.${PROFILE}.${id}.staging`);
    await fs.mkdir(path.dirname(paths.claude), { recursive: true, mode: 0o700 });
    await fs.cp(before.sourcePath, staging, { recursive: true, errorOnExist: true });
    if (claudeExisted) await fs.rename(paths.claude, path.join(backup, "claude-original"));
    try {
      await fs.rename(staging, paths.claude);
      await fs.chmod(paths.claude, 0o700);
    } catch (error) {
      if (claudeExisted) await fs.rename(path.join(backup, "claude-original"), paths.claude);
      throw error;
    }
    appliedTargets.push("claude");
  }

  if (glimmerChanged) {
    await fs.mkdir(paths.glimmer, { recursive: true, mode: 0o700 });
    for (const file of glimmerManifest.skills) {
      await atomicText(path.join(paths.glimmer, file), glimmerSkillContents.get(file)!, 0o600);
    }
    for (const obsolete of glimmerCandidates.filter(
      (file) => file.endsWith(".md") && !glimmerManifest.skills.includes(file),
    )) {
      await fs.unlink(path.join(paths.glimmer, obsolete)).catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await atomicText(
      path.join(paths.glimmer, ".creatorhub-engineering.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          name: PROFILE,
          version: glimmerManifest.version,
          installedAt: new Date().toISOString(),
          files: glimmerManifest.skills,
        },
        null,
        2,
      ),
      0o600,
    );
    appliedTargets.push("glimmer");
  }
  return { backupId: id, appliedTargets, preview: await previewIntegrationProfile(options) };
}

export async function rollbackIntegrationProfile(
  id: string,
  options: ProfileOptions = {},
): Promise<IntegrationProfileRollbackResult> {
  if (!SAFE_BACKUP_ID.test(id)) throw new Error("Invalid integration backup id.");
  const paths = locations(options);
  const backup = path.join(paths.backups, id);
  const manifestFile = path.join(backup, "manifest.json");
  await Promise.all([rejectSymlink(backup, false), rejectSymlink(manifestFile, false)]);
  const backupStat = await fs.stat(backup);
  if (!backupStat.isDirectory()) throw new Error("Integration backup is not a directory.");
  const manifest = parseBackupManifest(await readJson<unknown>(manifestFile), id);
  if (!manifest || manifest.rolledBackAt) {
    throw new Error("Integration backup is unavailable or already rolled back.");
  }
  const originalClaude = path.join(backup, "claude-original");
  if (manifest.claudeChanged && manifest.claudeExisted) {
    await rejectSymlink(originalClaude, false);
    if (!(await fs.stat(originalClaude)).isDirectory()) {
      throw new Error("Claude integration backup is invalid.");
    }
  }
  for (const file of manifest.glimmerChanged ? manifest.glimmerExistingFiles : []) {
    const original = path.join(backup, "glimmer", file);
    await rejectSymlink(original, false);
    if (!(await fs.stat(original)).isFile()) {
      throw new Error("Glimmer integration backup is invalid.");
    }
  }
  const current = path.join(backup, "current-at-rollback");
  await rejectSymlink(current);
  await Promise.all([rejectSymlink(paths.claude), rejectSymlink(paths.glimmer)]);
  await fs.mkdir(current, { mode: 0o700 });
  if (manifest.claudeChanged) {
    const currentClaudeExists = await fs
      .stat(paths.claude)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    if (currentClaudeExists) await fs.rename(paths.claude, path.join(current, "claude"));
    if (manifest.claudeExisted) {
      await fs.rename(originalClaude, paths.claude);
    }
  }
  await fs.mkdir(path.join(current, "glimmer"), { recursive: true, mode: 0o700 });
  for (const file of manifest.glimmerChanged
    ? [...manifest.glimmerExistingFiles, ...manifest.glimmerMissingFiles]
    : []) {
    const target = path.join(paths.glimmer, file);
    await rejectSymlink(target);
    try {
      await fs.copyFile(target, path.join(current, "glimmer", file));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (manifest.glimmerExistingFiles.includes(file)) {
      const original = path.join(backup, "glimmer", file);
      await fs.copyFile(original, target);
    } else {
      await fs.unlink(target).catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
  manifest.rolledBackAt = new Date().toISOString();
  await atomicText(path.join(backup, "manifest.json"), JSON.stringify(manifest, null, 2), 0o600);
  return { backupId: id, rolledBack: true, preview: await previewIntegrationProfile(options) };
}
