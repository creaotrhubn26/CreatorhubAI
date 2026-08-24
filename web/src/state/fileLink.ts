// Task A4: the one place that knows how to point at the read-only code
// surface, so every "open this path" affordance (repo map, doc-graph node,
// diff file header) produces the same URL shape.
//
// Paths are joined/split with a literal "/" — POSIX-only, the same ceiling
// PathPicker already carries.

export function fileHref(path: string, line?: number): string {
  const q = new URLSearchParams({ path });
  // Only a line that was actually known is carried — never a fabricated 1.
  if (line !== undefined && Number.isFinite(line) && line > 0) q.set("line", String(Math.floor(line)));
  return `/files?${q.toString()}`;
}

// Absolute path for a repo-relative one. A path that is already absolute is
// returned untouched, so a caller that has real absolute paths (the diff
// screen's session workspace) can pass them straight through.
export function absolutePath(workspace: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  return `${workspace.replace(/\/+$/, "")}/${relative.replace(/^\.\//, "")}`;
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
