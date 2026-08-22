import type { DocEdge, DocNode, DocNodeType } from "@glimmer/shared";

// Task 7.5 (V7 "System Explorer") -- fixed, deterministic section order so
// the same graph always renders the same grouping across reloads, never an
// alphabetical-by-whatever-arrived-first ordering.
const TYPE_ORDER: DocNodeType[] = ["system", "service", "route", "schema", "config", "doc"];
const TYPE_LABEL: Record<DocNodeType, string> = {
  system: "Systems", service: "Services", route: "Routes", schema: "Schemas", config: "Config", doc: "Docs",
};

export interface DocNodeGroup {
  type: DocNodeType;
  label: string;
  nodes: DocNode[];
}

// Plain case-insensitive substring match against id/title/path -- no query
// language, matching the task's "simple text filter" requirement.
export function filterDocNodes(nodes: DocNode[], query: string): DocNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.filter(
    (n) => n.id.toLowerCase().includes(q) || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
  );
}

export function groupDocNodesByType(nodes: DocNode[]): DocNodeGroup[] {
  return TYPE_ORDER.map((type) => ({ type, label: TYPE_LABEL[type], nodes: nodes.filter((n) => n.type === type) })).filter(
    (g) => g.nodes.length > 0
  );
}

export function edgesForNode(edges: DocEdge[], nodeId: string): { in: DocEdge[]; out: DocEdge[] } {
  return { in: edges.filter((e) => e.to === nodeId), out: edges.filter((e) => e.from === nodeId) };
}
