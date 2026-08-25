import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { DocEdge, DocNode } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { StatusBadge } from "../common/StatusBadge";
import { EmptyState } from "../common/EmptyState";
import { edgesForNode, filterDocNodes, groupDocNodesByType, str } from "../../state/docGraph";
import { absolutePath, fileHref, looksLikeDirectoryPath } from "../../state/fileLink";

// Task 7.5 (V7 "System Explorer") -- click-to-expand row, same shape as
// EvidencePanel: no separate detail fetch, the whole graph is already one
// payload so selection is just local state indexing into it.
function NodeRow({
  node,
  edges,
  workspace,
  selected,
  onSelect,
}: {
  node: DocNode;
  edges: DocEdge[];
  workspace: string;
  selected: boolean;
  onSelect(): void;
}) {
  const { in: inEdges, out: outEdges } = edgesForNode(edges, node.id);
  // Task A4: the node's own path opens in the read-only viewer. Only when the
  // graph actually recorded one — str() renders a missing path as
  // "Unavailable", which is not something to link anywhere — and only when
  // that path is a file: service nodes carry "." for the repo root, and
  // "Open file" on a directory is an affordance that cannot work.
  const recorded = typeof node.path === "string" && node.path.trim() ? node.path.trim() : null;
  const nodePath = recorded && !looksLikeDirectoryPath(recorded) ? recorded : null;
  return (
    <li className="row">
      <button
        type="button"
        onClick={onSelect}
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          width: "100%",
          textAlign: "left",
        }}
      >
        <StatusBadge status={node.status} />
        <span>{str(node.title)}</span>
        <code style={{ fontSize: 12, color: "var(--text-muted)" }}>{str(node.path)}</code>
      </button>
      {nodePath && (
        <Link
          to={fileHref(absolutePath(workspace, nodePath))}
          style={{ fontSize: 12, marginLeft: 8 }}
        >
          Open file
        </Link>
      )}
      {selected && (
        <div style={{ marginTop: 4, marginLeft: 12 }}>
          <dl>
            <dt>Id</dt>
            <dd className="mono">{node.id}</dd>
            <dt>Confidence</dt>
            <dd className="mono">{node.confidence}</dd>
            <dt>SHA</dt>
            {/* Provenance is displayed verbatim — a missing sha is a real
                fact (glimmer-v2.py never resolved one), never guessed.
                `provenance` itself may be absent (M5 fix: v2 tolerates a
                node with no provenance), so that's guarded too. */}
            <dd className="mono">{node.provenance?.sha ?? "Unavailable"}</dd>
          </dl>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Evidence</p>
          {!node.provenance?.evidence?.length ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>None recorded</p>
          ) : (
            <ul>
              {node.provenance.evidence.map((e, i) => (
                <li key={i} className="mono" style={{ fontSize: 12 }}>
                  {e}
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>In edges ({inEdges.length})</p>
          <ul>
            {inEdges.map((e, i) => (
              <li key={i} style={{ fontSize: 12 }}>
                {e.kind}: {e.from}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Out edges ({outEdges.length})</p>
          <ul>
            {outEdges.map((e, i) => (
              <li key={i} style={{ fontSize: 12 }}>
                {e.kind}: {e.to}
              </li>
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
  const { data, isPending, isError } = useQuery({
    queryKey: ["doc-graph"],
    queryFn: glimmerApi.getDocGraph,
    retry: false,
  });

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
        <EmptyState
          icon="○"
          text="No documentation graph in this repository — run --docs-bootstrap"
        />
      )}
      {!isError && data && (
        <>
          {/* M6 fix (round-7 review): findDocGraph returns the first
              docs/graph.json it finds across every session's workspace --
              with sessions against more than one repo, that graph could
              belong to a different repository than the one in view. Never
              render it as an unlabeled "this repository". */}
          <p className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Source: {data.source.workspace} (session {data.source.sessionId})
          </p>
          <input
            placeholder="Filter nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {groups.length === 0 && (
            <p style={{ color: "var(--text-muted)" }}>No nodes match "{query}"</p>
          )}
          {groups.map((g) => (
            <div className="session-list-group" key={g.type}>
              <h2 className="session-list-group__label">{g.label}</h2>
              <ul>
                {g.nodes.map((n) => (
                  <NodeRow
                    key={n.id}
                    node={n}
                    edges={data.edges}
                    workspace={data.source.workspace}
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
