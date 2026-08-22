import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DocEdge, DocNode } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";
import { edgesForNode, filterDocNodes, groupDocNodesByType } from "../../state/docGraph";

// Task 7.5 (V7 "System Explorer") -- click-to-expand row, same shape as
// EvidencePanel: no separate detail fetch, the whole graph is already one
// payload so selection is just local state indexing into it.
function NodeRow({
  node, edges, selected, onSelect,
}: {
  node: DocNode; edges: DocEdge[]; selected: boolean; onSelect(): void;
}) {
  const { in: inEdges, out: outEdges } = edgesForNode(edges, node.id);
  return (
    <li className="row">
      <button
        type="button"
        onClick={onSelect}
        style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%", textAlign: "left" }}
      >
        <StatusBadge status={node.status} />
        <span>{node.title}</span>
        <code style={{ fontSize: 12, color: "var(--text-muted)" }}>{node.path}</code>
      </button>
      {selected && (
        <div style={{ marginTop: 4, marginLeft: 12 }}>
          <dl>
            <dt>Id</dt>
            <dd className="mono">{node.id}</dd>
            <dt>Confidence</dt>
            <dd className="mono">{node.confidence}</dd>
            <dt>SHA</dt>
            {/* Provenance is displayed verbatim — a missing sha is a real
                fact (glimmer-v2.py never resolved one), never guessed. */}
            <dd className="mono">{node.provenance.sha ?? "Unavailable"}</dd>
          </dl>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Evidence</p>
          {node.provenance.evidence.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>None recorded</p>
          ) : (
            <ul>
              {node.provenance.evidence.map((e, i) => (
                <li key={i} className="mono" style={{ fontSize: 12 }}>{e}</li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>In edges ({inEdges.length})</p>
          <ul>
            {inEdges.map((e, i) => (
              <li key={i} style={{ fontSize: 12 }}>{e.kind}: {e.from}</li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Out edges ({outEdges.length})</p>
          <ul>
            {outEdges.map((e, i) => (
              <li key={i} style={{ fontSize: 12 }}>{e.kind}: {e.to}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

// Read-only documentation-graph browser (V7 "System Explorer"). Global,
// no session id needed — docs/graph.json belongs to the repo, not to any
// one session (see server/src/routes/repository.ts findDocGraph), same
// "no :id" shape as RepositoryMapScreen.
export function SystemExplorerScreen() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isPending, isError } = useQuery({ queryKey: ["doc-graph"], queryFn: glimmerApi.getDocGraph, retry: false });

  const filtered = useMemo(() => (data ? filterDocNodes(data.nodes, query) : []), [data, query]);
  const groups = useMemo(() => groupDocNodesByType(filtered), [filtered]);

  return (
    <div>
      <h1>System Explorer</h1>
      {/* isError is a real fetch/gateway fault; data === null (after loading
          finished) is the honest, common "no docs/graph.json anywhere"
          case — the two must read differently, not both as "Unavailable". */}
      {isError && <EmptyState icon="○" text="Unavailable" />}
      {!isError && !isPending && data === null && (
        <EmptyState icon="○" text="No documentation graph in this repository — run --docs-bootstrap" />
      )}
      {!isError && data && (
        <>
          <input placeholder="Filter nodes…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {groups.length === 0 && <p style={{ color: "var(--text-muted)" }}>No nodes match "{query}"</p>}
          {groups.map((g) => (
            <div className="session-list-group" key={g.type}>
              <h2 className="session-list-group__label">{g.label}</h2>
              <ul>
                {g.nodes.map((n) => (
                  <NodeRow
                    key={n.id}
                    node={n}
                    edges={data.edges}
                    selected={selectedId === n.id}
                    onSelect={() => setSelectedId(selectedId === n.id ? null : n.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
