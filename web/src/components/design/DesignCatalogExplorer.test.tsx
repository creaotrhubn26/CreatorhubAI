import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DesignCatalogProfile, DesignProfileReference } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { DesignCatalogExplorer } from "./DesignCatalogExplorer";

const profile: DesignCatalogProfile = {
  source: "creatorhub-catalog",
  id: "editorial",
  title: "Calm Editorial",
  description: "Quiet publication hierarchy for product workspaces.",
  version: "0.1.0",
  designHash: "a".repeat(64),
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
  score: 22,
  reasons: ["matched calm, editorial"],
  conflicts: [],
};

const facets = {
  schemaVersion: 2 as const,
  catalogVersion: "0.5.0",
  count: 143,
  source: "creatorhub-engineering" as const,
  categories: [{ value: profile.category, count: 12 }],
  profileTypes: [{ value: profile.profileType, count: 10 }],
  platforms: [{ value: "web", count: 143 }],
  productKinds: [{ value: "editorial", count: 20 }],
  tones: [{ value: "calm", count: 14 }],
  densities: [{ value: "balanced", count: 80 }],
  contrasts: [{ value: "medium", count: 80 }],
  modes: [{ value: "light", count: 120 }],
};

const library = {
  version: 1 as const,
  updatedAt: "2026-08-29T00:00:00.000Z",
  favorites: [] as string[],
  collections: [],
  customProfiles: [],
};

function withQuery(ui: React.ReactElement) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>
  );
}

function mockApi() {
  vi.spyOn(glimmerApi, "getDesignCatalogFacets").mockResolvedValue(facets);
  vi.spyOn(glimmerApi, "getDesignCatalogLibrary").mockResolvedValue(library);
  vi.spyOn(glimmerApi, "searchDesignCatalog").mockResolvedValue({
    query: "",
    total: 1,
    catalogVersion: "0.5.0",
    results: [profile],
  });
  vi.spyOn(glimmerApi, "getDesignCatalogProfile").mockResolvedValue(profile);
}

describe("DesignCatalogExplorer", () => {
  it("turns a profile into explicit durable adopt/reject direction", async () => {
    mockApi();
    const onChange = vi.fn();
    render(withQuery(<DesignCatalogExplorer value={[]} onChange={onChange} compact />));
    expect(await screen.findByText("Calm Editorial")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use as direction" }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        source: "creatorhub-catalog",
        profileId: "editorial",
        designHash: "a".repeat(64),
        adoptedQualities: ["calm hierarchy"],
        rejectedQualities: ["literal copying"],
      }),
    ]);
  });

  it("compares a selected profile to the repository token graph without writing source", async () => {
    mockApi();
    const selected: DesignProfileReference = {
      source: "creatorhub-catalog",
      profileId: "editorial",
      profileVersion: "0.1.0",
      designHash: "a".repeat(64),
      title: "Calm Editorial",
      adoptedQualities: ["calm hierarchy"],
      rejectedQualities: ["literal copying"],
    };
    render(
      withQuery(
        <DesignCatalogExplorer
          value={[selected]}
          onChange={vi.fn()}
          tokenGraph={[
            {
              name: "--color-primary",
              value: "#8B5E3C",
              path: "theme.css",
              line: 2,
              aliases: [],
              referencedBy: [],
            },
            {
              name: "--color-text",
              value: "#000000",
              path: "theme.css",
              line: 3,
              aliases: [],
              referencedBy: [],
            },
          ]}
        />,
      ),
    );
    expect(await screen.findByText("Token fit")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/1 match · 1 conflict · 1 missing/)).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Read-only comparison — source is never changed here."),
    ).toBeInTheDocument();
  });
});
