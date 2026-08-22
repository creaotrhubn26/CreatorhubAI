import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

// Task 5.2 (V7 §26/§46) -- simple list of evidence-index.json entries
// (id, kind, relatesTo count); clicking one loads its capped content
// on demand rather than fetching every entry's full evidence-NN.jsonl
// content up front.
export function EvidencePanel({ sessionId }: { sessionId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Opt-in artifact, written incrementally during the run — not a live
  // stream to poll, but it can still change while the session is active,
  // so this refetches like the other session-detail panels rather than
  // being a pure fetch-once.
  const { data } = useQuery({
    queryKey: ["evidence-index", sessionId],
    queryFn: () => glimmerApi.getEvidenceIndex(sessionId),
    enabled: !!sessionId,
    retry: false,
  });

  const { data: entry, isLoading: entryLoading } = useQuery({
    queryKey: ["evidence-entry", sessionId, selectedId],
    queryFn: () => glimmerApi.getEvidenceEntry(sessionId, selectedId!),
    enabled: !!sessionId && !!selectedId,
    retry: false,
  });

  const entries = data?.entries;
  // Absence is normal — most sessions never accumulate indexed evidence
  // (e.g. no interesting tool calls yet, or an older session predating
  // Task 5.2).
  if (!entries?.length) return null;

  return (
    <CollapsibleSection title="Evidence" summary={`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}>
      <ul className="evidence-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {entries.map((e) => (
          <li key={e.id} style={{ marginBottom: 4 }}>
            <button
              type="button"
              onClick={() => setSelectedId(e.id === selectedId ? null : e.id)}
              style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%", textAlign: "left" }}
            >
              <span className="meta-value">{e.kind}</span>
              <code style={{ fontSize: 12 }}>{e.id}</code>
              {e.path && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{e.path}</span>}
              {!!e.relatesTo?.length && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {e.relatesTo.length} relation{e.relatesTo.length === 1 ? "" : "s"}
                </span>
              )}
            </button>
            {selectedId === e.id && (
              <div style={{ marginTop: 4, marginLeft: 12 }}>
                {entryLoading && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</p>}
                {entry && (
                  <>
                    {entry.tool && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>tool: {entry.tool}</p>}
                    {entry.content && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{entry.content}</pre>}
                  </>
                )}
                {!!e.relatesTo?.length && (
                  <ul>
                    {e.relatesTo.map((r, i) => (
                      <li key={i} style={{ fontSize: 12 }}>{r.kind}: {r.path}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}
