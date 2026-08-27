import { useMemo, useRef, useState } from "react";
import type {
  LiveDesignInsertPreset,
  LiveDesignStructureNode,
  LiveDesignStructureOperationRequest,
  LiveDesignStructureSnapshot,
  LiveDesignStructureTarget,
} from "@glimmer/shared";

interface Props {
  snapshot: LiveDesignStructureSnapshot | null;
  selectedSelector: string;
  pending: LiveDesignStructureOperationRequest | null;
  canSave: boolean;
  busy: boolean;
  lockedSelectors: Set<string>;
  hiddenSelectors: Set<string>;
  blockedReason?: string;
  onSelect: (selector: string) => void;
  onHighlight: (selector: string) => void;
  onClearHighlight: () => void;
  onToggleLock: (selector: string) => void;
  onToggleVisibility: (selector: string) => void;
  onStage: (operation: LiveDesignStructureOperationRequest) => void;
  onApply: () => void;
  onCancel: () => void;
}

function targetFor(node: LiveDesignStructureNode): LiveDesignStructureTarget {
  return {
    selector: node.selector,
    tagName: node.tagName,
    text: node.text,
    attributes: node.attributes,
    ...(node.sourcePathHint ? { sourcePathHint: node.sourcePathHint } : {}),
    ...(node.framework ? { framework: node.framework } : {}),
    ...(node.componentName ? { componentName: node.componentName } : {}),
  };
}

interface LocatedNode {
  node: LiveDesignStructureNode;
  siblings: LiveDesignStructureNode[];
  index: number;
}

function locate(nodes: LiveDesignStructureNode[], selector: string): LocatedNode | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index].selector === selector) return { node: nodes[index], siblings: nodes, index };
    const nested = locate(nodes[index].children, selector);
    if (nested) return nested;
  }
  return undefined;
}

function operationLabel(operation: LiveDesignStructureOperationRequest): string {
  if (operation.kind === "insert") return `Insert ${operation.preset} ${operation.placement}`;
  if (operation.kind === "reorder")
    return `Move ${operation.moving.tagName} ${operation.placement}`;
  return `Move ${operation.moving.tagName} into ${operation.target.tagName}`;
}

function StructureTree({
  nodes,
  depth,
  selectedSelector,
  draggedSelector,
  setDraggedSelector,
  onSelect,
  onHighlight,
  onClearHighlight,
  lockedSelectors,
  onReparent,
}: {
  nodes: LiveDesignStructureNode[];
  depth: number;
  selectedSelector: string;
  draggedSelector: React.MutableRefObject<string>;
  setDraggedSelector: (selector: string) => void;
  onSelect: (selector: string) => void;
  onHighlight: (selector: string) => void;
  onClearHighlight: () => void;
  lockedSelectors: Set<string>;
  onReparent: (movingSelector: string, target: LiveDesignStructureNode) => void;
}) {
  return (
    <ul className="live-design-structure__tree" data-depth={depth}>
      {nodes.map((node) => (
        <li key={node.selector}>
          <button
            type="button"
            className={node.selector === selectedSelector ? "is-selected" : ""}
            draggable={node.tagName !== "body" && !lockedSelectors.has(node.selector)}
            aria-label={`Select ${node.label}`}
            title={node.selector}
            onClick={() => onSelect(node.selector)}
            onMouseEnter={() => onHighlight(node.selector)}
            onMouseLeave={onClearHighlight}
            onDragStart={() => {
              draggedSelector.current = node.selector;
              setDraggedSelector(node.selector);
            }}
            onDragEnd={() => {
              draggedSelector.current = "";
              setDraggedSelector("");
            }}
            onDragOver={(event) => {
              if (node.canHaveChildren && draggedSelector.current !== node.selector) {
                event.preventDefault();
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const moving = draggedSelector.current;
              if (moving && moving !== node.selector) onReparent(moving, node);
            }}
          >
            <span className="live-design-structure__tag">{node.tagName}</span>
            <span>{node.componentName || node.label}</span>
            {node.hidden && <small>hidden</small>}
            {lockedSelectors.has(node.selector) && <small>locked</small>}
          </button>
          {!!node.children.length && (
            <StructureTree
              nodes={node.children}
              depth={depth + 1}
              selectedSelector={selectedSelector}
              draggedSelector={draggedSelector}
              setDraggedSelector={setDraggedSelector}
              onSelect={onSelect}
              onHighlight={onHighlight}
              onClearHighlight={onClearHighlight}
              lockedSelectors={lockedSelectors}
              onReparent={onReparent}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function LiveDesignStructurePanel({
  snapshot,
  selectedSelector,
  pending,
  canSave,
  busy,
  lockedSelectors,
  hiddenSelectors,
  blockedReason,
  onSelect,
  onHighlight,
  onClearHighlight,
  onToggleLock,
  onToggleVisibility,
  onStage,
  onApply,
  onCancel,
}: Props) {
  const [preset, setPreset] = useState<LiveDesignInsertPreset>("section");
  const [placement, setPlacement] = useState<"inside-start" | "inside-end" | "before" | "after">(
    "inside-end",
  );
  const [text, setText] = useState("New section");
  const [dragging, setDragging] = useState("");
  const [query, setQuery] = useState("");
  const draggedSelector = useRef("");
  const selected = useMemo(
    () => (snapshot ? locate(snapshot.roots, selectedSelector) : undefined),
    [selectedSelector, snapshot],
  );
  const visibleRoots = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!snapshot || !normalized) return snapshot?.roots ?? [];
    const filter = (nodes: LiveDesignStructureNode[]): LiveDesignStructureNode[] =>
      nodes.flatMap((node) => {
        const children = filter(node.children);
        const matches = [
          node.label,
          node.tagName,
          node.text,
          node.componentName,
          node.attributes.id,
          node.attributes.class,
          node.attributes["data-testid"],
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalized));
        return matches || children.length ? [{ ...node, children }] : [];
      });
    return filter(snapshot.roots);
  }, [query, snapshot]);

  function stageReparent(movingSelector: string, target: LiveDesignStructureNode) {
    if (!snapshot) return;
    const moving = locate(snapshot.roots, movingSelector)?.node;
    if (!moving || !target.canHaveChildren) return;
    onStage({
      kind: "reparent",
      moving: targetFor(moving),
      target: targetFor(target),
      placement: "inside-end",
    });
  }

  function move(direction: "up" | "down") {
    if (!selected) return;
    const anchor =
      direction === "up"
        ? selected.siblings[selected.index - 1]
        : selected.siblings[selected.index + 1];
    if (!anchor) return;
    onStage({
      kind: "reorder",
      moving: targetFor(selected.node),
      anchor: targetFor(anchor),
      placement: direction === "up" ? "before" : "after",
    });
  }

  return (
    <section className="live-design-structure" aria-label="Page structure">
      <div className="live-design-structure__heading">
        <div>
          <h4>Navigator</h4>
          <small>
            {snapshot ? `${snapshot.total} DOM elements` : "Waiting for preview structure…"}
            {snapshot?.truncated ? " · capped at 500" : ""}
          </small>
        </div>
        {selected && (
          <div className="live-design-structure__move-actions">
            <button
              type="button"
              aria-pressed={lockedSelectors.has(selected.node.selector)}
              onClick={() => onToggleLock(selected.node.selector)}
            >
              {lockedSelectors.has(selected.node.selector) ? "Unlock" : "Lock"}
            </button>
            <button
              type="button"
              aria-pressed={hiddenSelectors.has(selected.node.selector)}
              onClick={() => onToggleVisibility(selected.node.selector)}
            >
              {hiddenSelectors.has(selected.node.selector) ? "Show" : "Hide"}
            </button>
            <button
              type="button"
              disabled={selected.index === 0 || busy || lockedSelectors.has(selected.node.selector)}
              aria-label="Move selected element up"
              onClick={() => move("up")}
            >
              ↑
            </button>
            <button
              type="button"
              disabled={
                selected.index === selected.siblings.length - 1 ||
                busy ||
                lockedSelectors.has(selected.node.selector)
              }
              aria-label="Move selected element down"
              onClick={() => move("down")}
            >
              ↓
            </button>
          </div>
        )}
      </div>
      <label className="live-design-structure__search">
        <span className="sr-only">Search Navigator</span>
        <input
          type="search"
          placeholder="Search elements or components…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {visibleRoots.length ? (
        <div className={`live-design-structure__tree-wrap${dragging ? " is-dragging" : ""}`}>
          <StructureTree
            nodes={visibleRoots}
            depth={0}
            selectedSelector={selectedSelector}
            draggedSelector={draggedSelector}
            setDraggedSelector={setDragging}
            onSelect={onSelect}
            onHighlight={onHighlight}
            onClearHighlight={onClearHighlight}
            lockedSelectors={lockedSelectors}
            onReparent={stageReparent}
          />
        </div>
      ) : (
        <p className="live-design-bridge__empty">Connect the preview to load its page tree.</p>
      )}

      <div className="live-design-structure__insert">
        <h4>Insert element</h4>
        <div className="live-design-bridge__number-grid">
          <label>
            Element
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value as LiveDesignInsertPreset)}
            >
              <option value="section">Section</option>
              <option value="heading">Heading</option>
              <option value="paragraph">Paragraph</option>
              <option value="button">Button</option>
              <option value="divider">Divider</option>
            </select>
          </label>
          <label>
            Position
            <select
              value={placement}
              onChange={(event) =>
                setPlacement(
                  event.target.value as "inside-start" | "inside-end" | "before" | "after",
                )
              }
            >
              <option value="inside-end">Inside · end</option>
              <option value="inside-start">Inside · start</option>
              <option value="after">After</option>
              <option value="before">Before</option>
            </select>
          </label>
        </div>
        {preset !== "divider" && (
          <label>
            Starter text
            <input value={text} maxLength={500} onChange={(event) => setText(event.target.value)} />
          </label>
        )}
        <button
          type="button"
          disabled={
            !selected ||
            busy ||
            ((placement === "inside-end" || placement === "inside-start") &&
              !selected.node.canHaveChildren)
          }
          onClick={() => {
            if (!selected) return;
            onStage({
              kind: "insert",
              target: targetFor(selected.node),
              placement,
              preset,
              text: preset === "divider" ? "" : text,
            });
          }}
        >
          Preview insert
        </button>
      </div>

      {pending && (
        <div className="live-design-structure__stage" role="status">
          <strong>Staged in preview</strong>
          <span>{operationLabel(pending)}</span>
          {!canSave && blockedReason && <small>{blockedReason}</small>}
          <div>
            <button type="button" disabled={!canSave || busy} onClick={onApply}>
              {busy ? "Saving…" : "Save structure to source"}
            </button>
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel preview
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
