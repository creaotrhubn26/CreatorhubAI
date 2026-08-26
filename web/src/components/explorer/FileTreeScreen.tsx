import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { EmptyState } from "../common/EmptyState";
import { IconChevron } from "../common/Icons";
import { CodeViewer } from "./CodeViewer";
import { WorkspaceHandoff } from "./WorkspaceHandoff";
import { ancestorDirs, mostSpecificContainingWorkspace } from "../../state/fileLink";

// Task A2: read-only file tree over GET /api/fs/dirs, rooted at a session
// workspace. Directories are listed only when they are actually expanded —
// one request per open directory, none for a closed one.
//
// URL is the state: ?path=<absolute file> opens it in the viewer and expands
// the branch that reveals it, &line=<n> marks a line.
//
// The tree browses the whole browse root (finding a workspace is its job), but
// CONTENT is only ever read inside a known workspace — the gateway enforces
// that itself (review M1), and a path in none of them is refused here rather
// than shown with a caveat.

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function DirNode({
  root,
  dir,
  label,
  expanded,
  onToggle,
  selectedPath,
  onOpenFile,
}: {
  root: string;
  dir: string;
  label: string;
  expanded: Set<string>;
  onToggle(dir: string): void;
  selectedPath: string | null;
  onOpenFile(path: string): void;
}) {
  const isOpen = expanded.has(dir);
  const { data, error, isFetching } = useQuery({
    queryKey: ["fs-dirs", root, dir, "tree"],
    queryFn: () => glimmerApi.listDirectory({ path: dir, root, includeFiles: true }),
    enabled: isOpen,
    retry: false,
  });

  return (
    <li className="file-tree__node">
      <button
        type="button"
        className="file-tree__row"
        aria-expanded={isOpen}
        onClick={() => onToggle(dir)}
      >
        <IconChevron open={isOpen} />
        <span className="file-tree__name">{label}</span>
      </button>
      {isOpen && (
        <>
          {/* A directory that could not be listed says so — an unexplained
              empty branch would read as "this directory is empty". */}
          {error && (
            <p role="alert" className="file-tree__note">
              Could not list this directory — {(error as Error).message}
            </p>
          )}
          {isFetching && !data && <p className="file-tree__note">Loading…</p>}
          {data && data.entries.length === 0 && <p className="file-tree__note">Empty directory.</p>}
          {data && (
            <ul className="file-tree__children">
              {data.entries.map((entry) => {
                const full = join(data.path, entry.name);
                return entry.isDir ? (
                  <DirNode
                    key={entry.name}
                    root={root}
                    dir={full}
                    label={entry.name}
                    expanded={expanded}
                    onToggle={onToggle}
                    selectedPath={selectedPath}
                    onOpenFile={onOpenFile}
                  />
                ) : (
                  <li className="file-tree__node" key={entry.name}>
                    <button
                      type="button"
                      className={`file-tree__row file-tree__row--file${full === selectedPath ? " is-selected" : ""}`}
                      aria-current={full === selectedPath ? "true" : undefined}
                      onClick={() => onOpenFile(full)}
                    >
                      <span className="file-tree__name">{entry.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {data?.truncated && (
            <p className="file-tree__note">
              Showing the first entries only — this directory has more.
            </p>
          )}
        </>
      )}
    </li>
  );
}

export function FileTreeScreen() {
  const [search, setSearch] = useSearchParams();
  const filePath = search.get("path");
  const lineParam = Number(search.get("line"));
  const line = Number.isFinite(lineParam) && lineParam > 0 ? lineParam : undefined;
  const startParam = Number(search.get("start"));
  const endParam = Number(search.get("end"));
  const selectedStart =
    Number.isInteger(startParam) &&
    Number.isInteger(endParam) &&
    startParam > 0 &&
    endParam >= startParam
      ? startParam
      : undefined;
  const selectedEnd = selectedStart === undefined ? undefined : endParam;

  const {
    data: workspaces,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["workspaces"],
    queryFn: glimmerApi.listWorkspaces,
    retry: false,
  });

  const [chosenRoot, setChosenRoot] = useState<string | null>(null);
  const roots = useMemo(() => (workspaces ?? []).map((w) => w.path), [workspaces]);
  const target = filePath;
  // A path arriving from elsewhere in the app (diff header, repo map, doc
  // graph) may belong to a different workspace than the one last chosen —
  // switch to the workspace that actually contains it rather than showing a
  // tree the file isn't in.
  const containing = target ? mostSpecificContainingWorkspace(roots, target) : undefined;
  const root = containing ?? chosenRoot ?? roots[0] ?? null;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!root) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(root);
      // Reveal the branch that leads to the file the URL points at (its
      // ancestors only — the file itself is not a directory to expand).
      if (target) for (const d of ancestorDirs(root, target)) next.add(d);
      return next.size === prev.size ? prev : next;
    });
  }, [root, target]);

  function toggle(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }

  function openFile(path: string) {
    // Preserve the originating session so its event stream stays alive while
    // the user browses files from that run. A new file clears the old line
    // range; it cannot honestly describe a different document.
    const next = new URLSearchParams({ path });
    const sessionId = search.get("session");
    if (sessionId) next.set("session", sessionId);
    setSearch(next);
  }

  function selectLines(startLine: number, endLine: number) {
    if (!filePath) return;
    const next = new URLSearchParams(search);
    next.set("path", filePath);
    next.set("start", String(startLine));
    next.set("end", String(endLine));
    next.delete("line");
    setSearch(next);
  }

  if (isError) {
    return (
      <div>
        <h1>Files</h1>
        <EmptyState
          icon="○"
          text="Unavailable — could not reach the gateway to find a workspace."
        />
      </div>
    );
  }
  if (isPending)
    return (
      <div>
        <h1>Files</h1>
        <p>Loading…</p>
      </div>
    );
  if (!root) {
    return (
      <div>
        <h1>Files</h1>
        <EmptyState
          icon="○"
          text="No workspace yet — a workspace appears here once a session has one."
        />
      </div>
    );
  }

  const outsideWorkspaces = !!(target && !containing);

  return (
    <div className="file-explorer">
      <div className="file-explorer__tree">
        <div className="file-explorer__roots">
          {roots.length > 1 ? (
            <select
              aria-label="Workspace"
              value={root}
              onChange={(e) => {
                setChosenRoot(e.target.value);
                setSearch({});
              }}
            >
              {roots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <span className="mono">{root}</span>
          )}
        </div>
        <WorkspaceHandoff workspace={root} />
        <ul className="file-tree">
          <DirNode
            root={root}
            dir={root}
            label={root.split("/").filter(Boolean).pop() ?? root}
            expanded={expanded}
            onToggle={toggle}
            selectedPath={filePath}
            onOpenFile={openFile}
          />
        </ul>
      </div>
      <div className="file-explorer__viewer">
        {/* Review M1: a path in no known workspace is REFUSED, not shown with
            a caveat. The gateway refuses it too — that is the boundary, this
            is only the honest message in front of it, since `?path=` comes
            straight from the URL. */}
        {outsideWorkspaces ? (
          <EmptyState
            icon="○"
            text="Not shown — this path is not inside any workspace Glimmer knows about."
          />
        ) : filePath ? (
          <CodeViewer
            path={filePath}
            line={line}
            selectionStart={selectedStart}
            selectionEnd={selectedEnd}
            workspace={root}
            onSelectionChange={selectLines}
          />
        ) : (
          <EmptyState icon="▤" text="Select a file to view it. This viewer is read-only." />
        )}
      </div>
    </div>
  );
}
