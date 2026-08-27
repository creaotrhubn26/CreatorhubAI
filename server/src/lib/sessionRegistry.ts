import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GlimmerSession, SessionPage } from "@glimmer/shared";
import { gatewayRunsDir, sessionIndexPath, sessionsDir } from "../config.js";
import { listSessionIds, readSession } from "./sessions.js";

interface RegistryEntry {
  fingerprint: string;
  session: GlimmerSession;
}

interface RegistryFile {
  version: 1;
  entries: Record<string, RegistryEntry>;
}

let loadedRegistry: RegistryFile | null = null;
let registryQueue: Promise<unknown> = Promise.resolve();

async function sourceFingerprint(id: string): Promise<string> {
  const sessionRoot = path.join(sessionsDir(), id);
  const sources = [
    path.join(sessionRoot, "manifest.json"),
    path.join(sessionRoot, "gateway-contract.json"),
    path.join(sessionRoot, "human-acceptance.json"),
    path.join(sessionRoot, "visual", "findings.json"),
    path.join(gatewayRunsDir(), `${id}.json`),
  ];
  return (
    await Promise.all(
      sources.map(async (source) => {
        try {
          const stat = await fs.stat(source, { bigint: true });
          return `${stat.mtimeNs}:${stat.size}`;
        } catch (error: any) {
          if (error?.code === "ENOENT") return "-";
          throw error;
        }
      }),
    )
  ).join("|");
}

async function loadRegistry(): Promise<RegistryFile> {
  if (loadedRegistry) return loadedRegistry;
  try {
    const parsed = JSON.parse(await fs.readFile(sessionIndexPath(), "utf8")) as RegistryFile;
    loadedRegistry =
      parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object"
        ? parsed
        : { version: 1, entries: {} };
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn(`[session-registry] rebuilding unreadable index: ${error?.message ?? error}`);
    }
    loadedRegistry = { version: 1, entries: {} };
  }
  return loadedRegistry;
}

async function saveRegistry(registry: RegistryFile): Promise<void> {
  const target = sessionIndexPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(registry), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

function cursorStart(ids: string[], cursor?: string): number {
  if (!cursor) return 0;
  const exact = ids.indexOf(cursor);
  if (exact >= 0) return exact + 1;
  const nextOlder = ids.findIndex((id) => id < cursor);
  return nextOlder >= 0 ? nextOlder : ids.length;
}

export function readSessionPage(options: { limit: number; cursor?: string }): Promise<SessionPage> {
  const work = registryQueue
    .catch(() => undefined)
    .then(async () => {
      const registry = await loadRegistry();
      const ids = await listSessionIds();
      const start = cursorStart(ids, options.cursor);
      const sessions: GlimmerSession[] = [];
      let changed = false;
      let index = start;
      let lastScannedId: string | null = null;
      while (index < ids.length && sessions.length < options.limit) {
        const id = ids[index];
        index += 1;
        lastScannedId = id;
        const fingerprint = await sourceFingerprint(id);
        let entry = registry.entries[id];
        if (!entry || entry.fingerprint !== fingerprint) {
          const session = await readSession(id);
          if (!session) {
            if (entry) {
              delete registry.entries[id];
              changed = true;
            }
            continue;
          }
          entry = { fingerprint, session };
          registry.entries[id] = entry;
          changed = true;
        }
        sessions.push(entry.session);
      }
      if (changed) await saveRegistry(registry);
      return {
        sessions,
        nextCursor: index < ids.length ? lastScannedId : null,
      };
    });
  registryQueue = work;
  return work;
}
