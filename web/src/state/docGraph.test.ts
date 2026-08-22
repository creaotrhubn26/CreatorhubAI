import { describe, it, expect } from "vitest";
import type { DocEdge, DocNode } from "@glimmer/shared";
import { edgesForNode, filterDocNodes, groupDocNodesByType } from "./docGraph";

function node(overrides: Partial<DocNode>): DocNode {
  return {
    id: "n1", type: "service", path: "server/src", title: "Gateway", status: "CURRENT", confidence: 0.9,
    provenance: { evidence: [], sha: null },
    ...overrides,
  };
}

describe("docGraph", () => {
  it("groups nodes by type in a fixed order, dropping empty groups", () => {
    const nodes = [
      node({ id: "d1", type: "doc", title: "Readme" }),
      node({ id: "s1", type: "service", title: "Gateway" }),
      node({ id: "s2", type: "system", title: "Role Room" }),
    ];
    const groups = groupDocNodesByType(nodes);
    expect(groups.map((g) => g.type)).toEqual(["system", "service", "doc"]);
    expect(groups.find((g) => g.type === "service")?.nodes.map((n) => n.id)).toEqual(["s1"]);
  });

  it("filters by case-insensitive substring on id/title/path", () => {
    const nodes = [
      node({ id: "svc:gateway", title: "Gateway", path: "server/src" }),
      node({ id: "svc:workspace", title: "Workspace", path: "web/src" }),
    ];
    expect(filterDocNodes(nodes, "gateway").map((n) => n.id)).toEqual(["svc:gateway"]);
    expect(filterDocNodes(nodes, "WEB/").map((n) => n.id)).toEqual(["svc:workspace"]);
    expect(filterDocNodes(nodes, "")).toEqual(nodes); // blank query -- no filtering
  });

  it("returns no fabricated matches for a query nothing satisfies", () => {
    expect(filterDocNodes([node({})], "nonexistent")).toEqual([]);
  });

  it("splits edges into in/out relative to a node id", () => {
    const edges: DocEdge[] = [
      { from: "a", to: "b", kind: "calls" },
      { from: "b", to: "c", kind: "calls" },
      { from: "c", to: "b", kind: "documents" },
    ];
    const { in: inEdges, out: outEdges } = edgesForNode(edges, "b");
    expect(inEdges).toEqual([{ from: "a", to: "b", kind: "calls" }, { from: "c", to: "b", kind: "documents" }]);
    expect(outEdges).toEqual([{ from: "b", to: "c", kind: "calls" }]);
  });
});
