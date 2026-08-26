import type { GatewayReadiness } from "@glimmer/shared";
import { glimmerApi } from "../api/client";
import {
  clearPendingUpdateSmoke,
  getInstalledAppVersion,
  readPendingUpdateSmoke,
  type PendingUpdateSmoke,
} from "./appUpdater";

export type PostUpdateSmokeResult =
  | { status: "success"; message: string }
  | { status: "failure"; message: string; rollbackUrl: string }
  | null;

export interface PostUpdateSmokeDependencies {
  getVersion?: () => Promise<string | null>;
  getReadiness?: () => Promise<GatewayReadiness>;
  readMarker?: () => PendingUpdateSmoke | null;
  clearMarker?: () => void;
  wait?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}

function safeReleaseVersion(version: string): string | null {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

export function rollbackReleaseUrl(version: string): string {
  const safe = safeReleaseVersion(version);
  return safe
    ? `https://github.com/creaotrhubn26/CreatorhubAI/releases/tag/v${encodeURIComponent(safe)}`
    : "https://github.com/creaotrhubn26/CreatorhubAI/releases";
}

export async function runPostUpdateSmoke(
  dependencies: PostUpdateSmokeDependencies = {},
): Promise<PostUpdateSmokeResult> {
  const marker = (dependencies.readMarker ?? readPendingUpdateSmoke)();
  if (!marker) return null;

  const getVersion = dependencies.getVersion ?? getInstalledAppVersion;
  const getReadiness = dependencies.getReadiness ?? glimmerApi.getReadiness;
  const wait =
    dependencies.wait ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = dependencies.attempts ?? 15;

  try {
    const installedVersion = await getVersion();
    if (installedVersion !== marker.toVersion) {
      throw new Error(
        `expected version ${marker.toVersion}, but the app reports ${installedVersion ?? "unknown"}`,
      );
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const readiness = await getReadiness();
        if (!readiness.coreReady) throw new Error("a required runtime component is unavailable");
        (dependencies.clearMarker ?? clearPendingUpdateSmoke)();
        return {
          status: "success",
          message: `Update ${marker.toVersion} passed the automatic startup test.`,
        };
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await wait(1_000);
      }
    }
    throw lastError ?? new Error("gateway readiness did not respond");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "failure",
      message: `Update ${marker.toVersion} did not pass its startup test: ${detail}. Reinstall the previous signed release if retrying does not help.`,
      rollbackUrl: rollbackReleaseUrl(marker.fromVersion),
    };
  }
}
