import { useDeferredValue, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DesignCatalogCustomProfileInput,
  DesignCatalogProfile,
  DesignProfileReference,
  LiveDesignTokenNode,
} from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

interface Props {
  value: DesignProfileReference[];
  onChange(value: DesignProfileReference[]): void;
  tokenGraph?: LiveDesignTokenNode[];
  projectContext?: {
    platform?: string;
    cms?: string;
    requirements?: string[];
    tokenNames?: string[];
  };
  compact?: boolean;
}

function referenceFor(profile: DesignCatalogProfile): DesignProfileReference {
  return {
    source: profile.source,
    profileId: profile.id,
    profileVersion: profile.version,
    designHash: profile.designHash,
    title: profile.title,
    adoptedQualities: profile.selection.adopt.slice(0, 8),
    rejectedQualities: profile.selection.avoid.slice(0, 8),
  };
}

function values(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function colors(value: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const entry of value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [role, color] = entry.split("=").map((item) => item.trim());
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(role ?? "") || !/^#[0-9a-f]{6}$/i.test(color ?? ""))
      return null;
    result[role] = color.toUpperCase();
  }
  return Object.keys(result).length ? result : null;
}

function TokenDiff({
  profiles,
  tokenGraph,
}: {
  profiles: DesignCatalogProfile[];
  tokenGraph: LiveDesignTokenNode[];
}) {
  const rows = profiles.flatMap((profile) =>
    Object.entries(profile.colors).map(([role, value]) => {
      const exact = tokenGraph.find((token) => token.value.toLowerCase() === value.toLowerCase());
      const semantic = tokenGraph.find((token) =>
        token.name.toLowerCase().includes(role.toLowerCase()),
      );
      return {
        id: `${profile.id}-${role}`,
        profile: profile.title,
        role,
        value,
        status: exact ? "match" : semantic ? "conflict" : "missing",
        repository: exact
          ? exact.name
          : semantic
            ? `${semantic.name} = ${semantic.value}`
            : "No semantic token",
      };
    }),
  );
  const summary = rows.reduce(
    (result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  return (
    <section
      className="design-catalog__token-diff"
      aria-label="Profile to repository token comparison"
    >
      <header>
        <div>
          <strong>Token fit</strong>
          <small>Read-only comparison — source is never changed here.</small>
        </div>
        <span>
          {summary.match ?? 0} match · {summary.conflict ?? 0} conflict · {summary.missing ?? 0}{" "}
          missing
        </span>
      </header>
      <div className="design-catalog__token-grid">
        {rows.slice(0, 24).map((row) => (
          <div key={row.id} className={`design-catalog__token-row is-${row.status}`}>
            <span className="design-catalog__swatch" style={{ background: row.value }} />
            <div>
              <strong>{row.role}</strong>
              <small>{row.profile}</small>
            </div>
            <code>{row.value}</code>
            <span>{row.repository}</span>
            <em>{row.status}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DesignCatalogExplorer({
  value,
  onChange,
  tokenGraph = [],
  projectContext,
  compact = false,
}: Props) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [profileType, setProfileType] = useState("");
  const [tone, setTone] = useState("");
  const [collectionTitle, setCollectionTitle] = useState("");
  const [custom, setCustom] = useState({
    title: "",
    description: "",
    category: "Custom",
    tones: "calm",
    colors: "primary=#4F46E5, surface=#FFFFFF, text=#17181A",
    adopt: "clear hierarchy",
    avoid: "literal copying",
  });
  const deferredQuery = useDeferredValue(query);
  const facets = useQuery({
    queryKey: ["design-catalog", "facets"],
    queryFn: glimmerApi.getDesignCatalogFacets,
    retry: false,
  });
  const library = useQuery({
    queryKey: ["design-catalog", "library"],
    queryFn: glimmerApi.getDesignCatalogLibrary,
    retry: false,
  });
  const search = useQuery({
    queryKey: [
      "design-catalog",
      "search",
      deferredQuery,
      category,
      profileType,
      tone,
      projectContext,
    ],
    queryFn: () =>
      glimmerApi.searchDesignCatalog({
        query: deferredQuery,
        limit: compact ? 9 : 18,
        filters: {
          ...(category ? { category } : {}),
          ...(profileType ? { profileType } : {}),
          ...(tone ? { tone } : {}),
        },
        ...(projectContext ? { projectContext } : {}),
      }),
    retry: false,
  });
  const selectedQueries = useQueries({
    queries: value.map((reference) => ({
      queryKey: ["design-catalog", "profile", reference.profileId],
      queryFn: () => glimmerApi.getDesignCatalogProfile(reference.profileId),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const selectedProfiles = selectedQueries.flatMap((item) => (item.data ? [item.data] : []));
  const saveLibrary = useMutation({
    mutationFn: glimmerApi.saveDesignCatalogLibrary,
    onSuccess: (next) => queryClient.setQueryData(["design-catalog", "library"], next),
  });
  const createCustom = useMutation({
    mutationFn: glimmerApi.createCustomDesignProfile,
    onSuccess: (next) => {
      queryClient.setQueryData(["design-catalog", "library"], next);
      void queryClient.invalidateQueries({ queryKey: ["design-catalog", "search"] });
      setCustom((current) => ({ ...current, title: "", description: "" }));
    },
  });
  const deleteCustom = useMutation({
    mutationFn: glimmerApi.deleteCustomDesignProfile,
    onSuccess: (next, id) => {
      queryClient.setQueryData(["design-catalog", "library"], next);
      onChange(value.filter((item) => item.profileId !== id));
      void queryClient.invalidateQueries({ queryKey: ["design-catalog", "search"] });
    },
  });
  const selectedIds = useMemo(() => new Set(value.map((item) => item.profileId)), [value]);
  const favorites = new Set(library.data?.favorites ?? []);

  function toggle(profile: DesignCatalogProfile) {
    if (selectedIds.has(profile.id))
      onChange(value.filter((item) => item.profileId !== profile.id));
    else if (value.length < 3) onChange([...value, referenceFor(profile)]);
  }

  function toggleFavorite(profileId: string) {
    const next = favorites.has(profileId)
      ? [...favorites].filter((id) => id !== profileId)
      : [...favorites, profileId];
    saveLibrary.mutate({ favorites: next });
  }

  function submitCustom(event: React.FormEvent) {
    event.preventDefault();
    const palette = colors(custom.colors);
    const tones = values(custom.tones);
    const adopt = values(custom.adopt);
    if (!custom.title.trim() || !palette || !tones.length || !adopt.length) return;
    const input: DesignCatalogCustomProfileInput = {
      title: custom.title.trim(),
      description: custom.description.trim(),
      category: custom.category.trim() || "Custom",
      tones,
      colors: palette,
      adopt,
      avoid: values(custom.avoid),
    };
    createCustom.mutate(input);
  }

  function saveCollection() {
    const title = collectionTitle.trim();
    if (!title || !value.length) return;
    const existing = library.data?.collections ?? [];
    const id =
      title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || `collection-${Date.now()}`;
    saveLibrary.mutate({
      collections: [
        ...existing.filter((item) => item.id !== id),
        { id, title, profileIds: value.map((item) => item.profileId) },
      ],
    });
    setCollectionTitle("");
  }

  return (
    <section className={`design-catalog ${compact ? "is-compact" : ""}`}>
      <header className="design-catalog__header">
        <div>
          <span className="design-catalog__eyebrow">CreatorHub design intelligence</span>
          <h3>Design profile library</h3>
          <p>
            Choose qualities to adopt—not screens to copy. Up to three profiles become durable task
            direction.
          </p>
        </div>
        <div className="design-catalog__catalog-status">
          <strong>{facets.data?.count ?? "—"}</strong>
          <span>curated profiles</span>
          <small>{facets.data ? `v${facets.data.catalogVersion}` : "Loading catalogue…"}</small>
        </div>
      </header>
      <div className="design-catalog__toolbar">
        <label className="design-catalog__search">
          <span>Search intent</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="calm editorial dashboard, warm AI workspace…"
          />
        </label>
        <label>
          <span>Category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All</option>
            {facets.data?.categories.map((item) => (
              <option key={item.value} value={item.value}>
                {item.value} ({item.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select value={profileType} onChange={(event) => setProfileType(event.target.value)}>
            <option value="">All</option>
            {facets.data?.profileTypes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.value} ({item.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Tone</span>
          <select value={tone} onChange={(event) => setTone(event.target.value)}>
            <option value="">All</option>
            {facets.data?.tones.slice(0, 24).map((item) => (
              <option key={item.value} value={item.value}>
                {item.value} ({item.count})
              </option>
            ))}
          </select>
        </label>
      </div>
      {search.isError && (
        <p role="alert" className="design-catalog__error">
          {search.error.message}
        </p>
      )}
      <div className="design-catalog__grid" aria-busy={search.isLoading}>
        {search.data?.results.map((profile) => {
          const selected = selectedIds.has(profile.id);
          return (
            <article
              key={profile.id}
              className={`design-profile-card ${selected ? "is-selected" : ""}`}
            >
              <div className="design-profile-card__preview">
                <img src={glimmerApi.designCatalogPreviewUrl(profile.id)} alt="" loading="lazy" />
                <div>
                  <span>{profile.category}</span>
                  <span>{profile.quality.overall}/100</span>
                </div>
              </div>
              <div className="design-profile-card__body">
                <header>
                  <div>
                    <strong>{profile.title}</strong>
                    <small>
                      {profile.profileType} · {profile.quality.evidence}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={favorites.has(profile.id) ? "is-favorite" : ""}
                    aria-label={`${favorites.has(profile.id) ? "Remove" : "Add"} ${profile.title} ${favorites.has(profile.id) ? "from" : "to"} favorites`}
                    onClick={() => toggleFavorite(profile.id)}
                  >
                    ★
                  </button>
                </header>
                <p>{profile.description}</p>
                <div className="design-profile-card__chips">
                  {profile.characteristics.tones.slice(0, 4).map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
                {!!profile.reasons?.length && (
                  <small className="design-profile-card__reason">
                    {profile.reasons.join(" · ")}
                  </small>
                )}
                {!!profile.conflicts?.length && (
                  <small className="design-profile-card__risk">
                    Verify: {profile.conflicts.join(" · ")}
                  </small>
                )}
                <footer>
                  <button
                    type="button"
                    className={selected ? "secondary" : "primary"}
                    disabled={!selected && value.length >= 3}
                    onClick={() => toggle(profile)}
                  >
                    {selected ? "Remove direction" : "Use as direction"}
                  </button>
                  {profile.source === "custom" && (
                    <button type="button" onClick={() => deleteCustom.mutate(profile.id)}>
                      Delete
                    </button>
                  )}
                </footer>
              </div>
            </article>
          );
        })}
      </div>
      {!search.isLoading && !search.data?.results.length && !search.isError && (
        <p className="design-catalog__empty">
          No profile matched this combination. Clear a filter or describe the desired feeling
          instead.
        </p>
      )}
      {!!value.length && (
        <section className="design-catalog__selection">
          <header>
            <div>
              <strong>Direction stack · {value.length}/3</strong>
              <small>Explicit adopt/reject boundaries are stored with the task.</small>
            </div>
            <div className="design-catalog__collection">
              <input
                aria-label="Collection name"
                value={collectionTitle}
                onChange={(event) => setCollectionTitle(event.target.value)}
                placeholder="Save as collection…"
              />
              <button type="button" disabled={!collectionTitle.trim()} onClick={saveCollection}>
                Save
              </button>
            </div>
          </header>
          <div className="design-catalog__comparison">
            {value.map((reference) => (
              <article key={reference.profileId}>
                <strong>{reference.title}</strong>
                <span>Adopt</span>
                <p>{reference.adoptedQualities.join(" · ")}</p>
                <span>Avoid</span>
                <p>{reference.rejectedQualities.join(" · ") || "Literal copying"}</p>
              </article>
            ))}
          </div>
          {!!tokenGraph.length && !!selectedProfiles.length && (
            <TokenDiff profiles={selectedProfiles} tokenGraph={tokenGraph} />
          )}
        </section>
      )}
      {!!library.data?.collections.length && (
        <details className="design-catalog__saved">
          <summary>Saved collections ({library.data.collections.length})</summary>
          <div>
            {library.data.collections.map((collection) => (
              <button
                type="button"
                key={collection.id}
                onClick={() =>
                  Promise.all(
                    collection.profileIds.slice(0, 3).map(glimmerApi.getDesignCatalogProfile),
                  ).then((profiles) => onChange(profiles.map(referenceFor)))
                }
              >
                <strong>{collection.title}</strong>
                <span>{collection.profileIds.length} profiles</span>
              </button>
            ))}
          </div>
        </details>
      )}
      <details className="design-catalog__custom">
        <summary>Create a custom profile</summary>
        <form onSubmit={submitCustom}>
          <label>
            Title
            <input
              value={custom.title}
              onChange={(event) => setCustom({ ...custom, title: event.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              value={custom.description}
              onChange={(event) => setCustom({ ...custom, description: event.target.value })}
            />
          </label>
          <div>
            <label>
              Category
              <input
                value={custom.category}
                onChange={(event) => setCustom({ ...custom, category: event.target.value })}
              />
            </label>
            <label>
              Tones, comma separated
              <input
                value={custom.tones}
                onChange={(event) => setCustom({ ...custom, tones: event.target.value })}
              />
            </label>
          </div>
          <label>
            Colors, role=#RRGGBB
            <textarea
              value={custom.colors}
              onChange={(event) => setCustom({ ...custom, colors: event.target.value })}
            />
          </label>
          <label>
            Adopt qualities
            <input
              value={custom.adopt}
              onChange={(event) => setCustom({ ...custom, adopt: event.target.value })}
            />
          </label>
          <label>
            Avoid qualities
            <input
              value={custom.avoid}
              onChange={(event) => setCustom({ ...custom, avoid: event.target.value })}
            />
          </label>
          <button
            type="submit"
            disabled={createCustom.isPending || !custom.title.trim() || !colors(custom.colors)}
          >
            Save custom profile
          </button>
        </form>
      </details>
    </section>
  );
}
