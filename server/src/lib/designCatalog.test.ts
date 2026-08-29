import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCustomDesignProfile,
  deleteCustomDesignProfile,
  designCatalogFacets,
  DesignCatalogError,
  getDesignCatalogProfile,
  readDesignCatalogLibrary,
  renderDesignCatalogPreview,
  searchDesignCatalog,
  updateDesignCatalogLibrary,
} from "./designCatalog.js";

const hash = createHash("sha256").update("design").digest("hex");

function profile(id: string, title: string, tones: string[], colors: Record<string, string>) {
  return {
    id,
    title,
    description: `${title} is a ${tones.join(" ")} product direction.`,
    version: "0.1.0",
    license: "MIT",
    category: "Editorial & Publishing",
    profileType: "visual-archetype",
    platforms: ["web"],
    productKinds: ["dashboard", "editorial"],
    tags: ["design-system"],
    characteristics: {
      tones,
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
    colors,
    components: ["cards", "navigation"],
    layouts: ["editorial", "grid"],
    quality: {
      completeness: 90,
      richness: 80,
      overall: 87,
      evidence: "curated",
      referenceRisk: "low",
    },
    selection: {
      adopt: ["calm", "editorial hierarchy"],
      verify: ["repository tokens"],
      avoid: ["literal copying"],
    },
    sha256: { design: hash, manifest: hash },
    searchText: `${id} ${title} ${tones.join(" ")} ${id === "editorial" ? "publication" : "analytics"}`,
  };
}

describe("design catalogue", () => {
  let root: string;
  let catalogPath: string;
  let libraryPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-design-catalog-"));
    catalogPath = path.join(root, "catalog.json");
    libraryPath = path.join(root, "state", "library.json");
    const profiles = [
      profile("editorial", "Calm Editorial", ["calm", "editorial"], {
        primary: "#8B5E3C",
        surface: "#FAF7F2",
        text: "#201A17",
      }),
      profile("dashboard", "Dense Dashboard", ["professional", "data-dense"], {
        primary: "#2563EB",
        surface: "#FFFFFF",
        text: "#111827",
      }),
    ];
    await fs.writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        count: profiles.length,
        facets: {},
        profiles,
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("validates, facets, and searches design intent with Norwegian synonyms", async () => {
    const options = { catalogPath, libraryPath };
    const facets = await designCatalogFacets(options);
    expect(facets.count).toBe(2);
    expect(facets.categories).toEqual([{ value: "Editorial & Publishing", count: 2 }]);
    const result = await searchDesignCatalog({ query: "rolig redaksjonell", limit: 2 }, options);
    expect(result.results[0]).toMatchObject({ id: "editorial", source: "creatorhub-catalog" });
    expect(result.results[0].reasons?.[0]).toContain("matched");
    expect((result.results[0] as any).searchText).toBeUndefined();
  });

  it("stores favorites, collections, and custom profiles atomically", async () => {
    const options = { catalogPath, libraryPath };
    const created = await createCustomDesignProfile(
      {
        title: "CreatorHub warm workspace",
        description: "A custom product direction",
        category: "Custom",
        tones: ["warm", "calm"],
        colors: { primary: "#C96442", surface: "#F5F4ED" },
        adopt: ["warm hierarchy"],
        avoid: ["brand imitation"],
      },
      options,
    );
    const custom = created.customProfiles[0];
    expect(custom.id).toMatch(/^custom-/);
    const updated = await updateDesignCatalogLibrary(
      {
        favorites: ["editorial", custom.id],
        collections: [
          { id: "calm-stack", title: "Calm stack", profileIds: ["editorial", custom.id] },
        ],
      },
      options,
    );
    expect(updated.favorites).toHaveLength(2);
    expect((await getDesignCatalogProfile(custom.id, options)).title).toBe(
      "CreatorHub warm workspace",
    );
    const removed = await deleteCustomDesignProfile(custom.id, options);
    expect(removed.customProfiles).toEqual([]);
    expect(removed.favorites).toEqual(["editorial"]);
    expect((await readDesignCatalogLibrary(options)).collections[0].profileIds).toEqual([
      "editorial",
    ]);
  });

  it("renders inert SVG and refuses a symlinked catalogue", async () => {
    const options = { catalogPath, libraryPath };
    const svg = renderDesignCatalogPreview(await getDesignCatalogProfile("editorial", options));
    expect(svg).toMatch(/^<svg/);
    expect(svg).not.toMatch(/<script|javascript:/i);
    const linked = path.join(root, "linked.json");
    await fs.symlink(catalogPath, linked);
    await expect(designCatalogFacets({ catalogPath: linked, libraryPath })).rejects.toBeInstanceOf(
      DesignCatalogError,
    );
  });
});
