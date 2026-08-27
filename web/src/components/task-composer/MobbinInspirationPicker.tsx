import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { DesignInspiration, MobbinPlatform } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

export function MobbinInspirationPicker({
  value,
  onChange,
}: {
  value: DesignInspiration[];
  onChange(value: DesignInspiration[]): void;
}) {
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<MobbinPlatform>("web");
  const status = useQuery({
    queryKey: ["mobbin-integration"],
    queryFn: glimmerApi.getMobbinIntegration,
    staleTime: 15_000,
  });
  const search = useMutation({
    mutationFn: () => glimmerApi.searchMobbin({ query: query.trim(), platform, limit: 8 }),
  });

  function add(screen: NonNullable<typeof search.data>["screens"][number]) {
    if (value.some((item) => item.screenId === screen.id)) return;
    onChange([
      ...value,
      {
        source: "mobbin",
        screenId: screen.id,
        appName: screen.appName,
        platform: screen.platform,
        mobbinUrl: screen.mobbinUrl,
        query: search.data?.query ?? query.trim(),
      },
    ]);
  }

  return (
    <div className="mobbin-picker">
      <div className="mobbin-picker__heading">
        <div>
          <strong>Mobbin library</strong>
          <small>Search one screen intent at a time and attach references to this task.</small>
        </div>
        <a href="/settings">{status.data?.configured ? "Connection settings" : "Connect Mobbin"}</a>
      </div>
      <div className="mobbin-picker__search">
        <label>
          Screen intent
          <input
            value={query}
            maxLength={500}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="checkout page with promo code and Apple Pay"
          />
        </label>
        <label>
          Platform
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as MobbinPlatform)}
          >
            <option value="web">Web</option>
            <option value="ios">iOS</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => search.mutate()}
          disabled={!status.data?.configured || !query.trim() || search.isPending}
        >
          {search.isPending ? "Searching…" : "Search Mobbin"}
        </button>
      </div>
      {!status.isLoading && !status.data?.configured && (
        <p className="muted">Connect a Team or Enterprise API key in Settings to search.</p>
      )}
      {search.error && <p role="alert">Mobbin search failed — {(search.error as Error).message}</p>}
      {!!search.data?.screens.length && (
        <div className="mobbin-picker__results" aria-label="Mobbin search results">
          {search.data.screens.map((screen) => {
            const selected = value.some((item) => item.screenId === screen.id);
            return (
              <article key={screen.id}>
                <img
                  src={glimmerApi.mobbinImageUrl(screen.imageToken)}
                  alt={`${screen.appName} ${screen.platform} reference`}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
                <strong>{screen.appName}</strong>
                <span>{screen.platform}</span>
                <button type="button" disabled={selected} onClick={() => add(screen)}>
                  {selected ? "Added" : "Use reference"}
                </button>
              </article>
            );
          })}
        </div>
      )}
      {!!value.length && (
        <div>
          <strong>Attached inspiration</strong>
          <ul className="mobbin-picker__selected">
            {value.map((item) => (
              <li key={item.screenId}>
                <a href={item.mobbinUrl} target="_blank" rel="noreferrer">
                  {item.appName} · {item.platform}
                </a>
                <button
                  type="button"
                  aria-label={`Remove ${item.appName} inspiration`}
                  onClick={() =>
                    onChange(value.filter((candidate) => candidate.screenId !== item.screenId))
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <small>
        Previews are proxied through Glimmer and expire; the Mobbin screen link and search intent
        remain attached.
      </small>
    </div>
  );
}
