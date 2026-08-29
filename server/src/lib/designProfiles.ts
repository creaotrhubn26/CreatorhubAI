import type { DesignProfileReference } from "@glimmer/shared";

const BUILTIN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const CUSTOM_ID = /^custom-[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/i;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function strings(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const item of value) {
    const normalized = text(item, maxChars);
    if (!normalized) return null;
    result.push(normalized);
  }
  return [...new Set(result)];
}

export function normalizeDesignProfiles(value: unknown): DesignProfileReference[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const result: DesignProfileReference[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (
      Object.keys(raw).some(
        (key) =>
          ![
            "source",
            "profileId",
            "profileVersion",
            "designHash",
            "title",
            "adoptedQualities",
            "rejectedQualities",
          ].includes(key),
      )
    )
      return null;
    const source = raw.source;
    const profileId = text(raw.profileId, 100);
    const profileVersion = text(raw.profileVersion, 100);
    const designHash = text(raw.designHash, 64);
    const title = text(raw.title, 200);
    const adoptedQualities = strings(raw.adoptedQualities, 12, 200);
    const rejectedQualities = strings(raw.rejectedQualities, 12, 500);
    if (
      (source !== "creatorhub-catalog" && source !== "custom") ||
      !profileId ||
      !(source === "custom" ? CUSTOM_ID : BUILTIN_ID).test(profileId) ||
      ids.has(profileId) ||
      !profileVersion ||
      !designHash ||
      !HASH.test(designHash) ||
      !title ||
      !adoptedQualities ||
      !adoptedQualities.length ||
      !rejectedQualities
    )
      return null;
    ids.add(profileId);
    result.push({
      source,
      profileId,
      profileVersion,
      designHash: designHash.toLowerCase(),
      title,
      adoptedQualities,
      rejectedQualities,
    });
  }
  return result;
}
