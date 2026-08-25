// Task A4: the one place that knows how to point at the read-only code
// surface, so every "open this path" affordance (repo map, doc-graph node,
// diff file header) produces the same URL shape.
//
// Paths are joined/split with a literal "/" — POSIX-only, the same ceiling
// PathPicker already carries.

export function fileHref(path: string, line?: number, sessionId?: string): string {
  const q = new URLSearchParams({ path });
  // Only a line that was actually known is carried — never a fabricated 1.
  if (line !== undefined && Number.isFinite(line) && line > 0) q.set("line", String(Math.floor(line)));
  // A diff-originated file keeps the session context that emitted
  // file_changed events. Repo-map/doc-graph links omit it because they do not
  // name a run, and inventing one would make live-refresh provenance false.
  if (sessionId) q.set("session", sessionId);
  return `/files?${q.toString()}`;
}

// True when a recorded path plainly names a DIRECTORY rather than a file —
// doc-graph service nodes carry "." for the repo root, and offering to open
// that "file" would be an affordance that cannot work. This only recognises
// the unambiguous spellings; anything else needs a stat, which is the
// gateway's job (it answers "path is a directory" honestly).
export function looksLikeDirectoryPath(p: string): boolean {
  if (p.endsWith("/")) return true;
  const last = p.split("/").pop() ?? "";
  return last === "." || last === "..";
}

// Absolute path for a repo-relative one. A path that is already absolute is
// returned untouched, so a caller that has real absolute paths (the diff
// screen's session workspace) can pass them straight through.
export function absolutePath(workspace: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  return `${workspace.replace(/\/+$/, "")}/${relative.replace(/^\.\//, "")}`;
}

// A file can technically sit inside nested known workspaces. The deepest
// match is the workspace that gives the narrowest, correct relative scope
// and the right base for session-relative file_changed event paths.
export function mostSpecificContainingWorkspace(workspaces: string[], target: string): string | undefined {
  let best: string | undefined;
  for (const workspace of workspaces) {
    const root = workspace.replace(/\/+$/, "") || "/";
    const contains = root === "/" ? target.startsWith("/") : target === root || target.startsWith(root + "/");
    if (contains && (!best || root.length > best.length)) best = root;
  }
  return best;
}

// Every directory between `root` (inclusive) and `target` (exclusive of the
// target itself), so the tree can expand exactly the branch that reveals it.
// Returns [] when `target` is not inside `root` — the caller then has nothing
// honest to expand, rather than a guessed path.
export function ancestorDirs(root: string, target: string): string[] {
  const base = root.replace(/\/+$/, "");
  if (target !== base && !target.startsWith(base + "/")) return [];
  const rest = target.slice(base.length).split("/").filter(Boolean);
  const dirs = [base];
  let current = base;
  for (const segment of rest.slice(0, -1)) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}
