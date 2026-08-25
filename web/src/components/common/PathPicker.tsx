import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { pickPathsNatively } from "../../state/pickPath";

// Task 4c(2/3): one picker for both composer path fields.
//
// Desktop (Tauri): a real Finder chooser via the dialog plugin.
// Browser/dev: the gateway's read-only directory browser (GET /api/fs/dirs),
// which lists names only and refuses anything outside `root` (defaults
// server-side to the user's home directory).
//
// Selection is always handed back as ABSOLUTE paths — callers that need a
// workspace-relative path convert (see NewTaskScreen's toWorkspaceRelative).
// Paths below are joined with a literal "/" (review MN8): POSIX-only, which
// matches where this app ships today; a Windows shell would need path
// semantics from the server's response instead.
export function PathPicker({
  mode,
  root,
  buttonLabel = "Browse…",
  disabledReason,
  onPick,
}: {
  mode: "directory" | "files";
  root?: string;
  buttonLabel?: string;
  disabledReason?: string;
  onPick(paths: string[]): void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [cwd, setCwd] = useState<string | undefined>(root);
  const [checked, setChecked] = useState<string[]>([]);
  const [nativeError, setNativeError] = useState<string | null>(null);

  const { data, error, isFetching } = useQuery({
    queryKey: ["fs-dirs", root ?? "", cwd ?? "", mode],
    queryFn: () => glimmerApi.listDirectory({ path: cwd, root, includeFiles: mode === "files" }),
    enabled: browsing,
    retry: false,
  });

  async function browse() {
    setNativeError(null);
    try {
      const picked = await pickPathsNatively({
        directory: mode === "directory",
        multiple: mode === "files",
        defaultPath: root,
      });
      if (picked !== null) {
        // Native dialog handled it (empty array = user cancelled).
        if (picked.length > 0) onPick(picked);
        return;
      }
    } catch (err: any) {
      // The desktop dialog was available but failed — say so rather than
      // silently pretending we're in a browser.
      setNativeError(err?.message ?? String(err));
      return;
    }
    setCwd(root);
    setChecked([]);
    setBrowsing(true);
  }

  return (
    <div className="path-picker">
      <button type="button" onClick={browse} disabled={!!disabledReason}>
        {buttonLabel}
      </button>
      {disabledReason && <span className="path-picker__hint"> {disabledReason}</span>}
      {nativeError && <span role="alert"> Native file dialog failed: {nativeError}</span>}

      {browsing && (
        <div className="path-picker__browser">
          <div className="path-picker__bar">
            <code>{data?.path ?? cwd ?? "…"}</code>
            <button type="button" onClick={() => setBrowsing(false)}>
              Close
            </button>
          </div>
          {error && <p role="alert">{(error as Error).message}</p>}
          {isFetching && !data && <p>Loading…</p>}
          {data && (
            <>
              <ul className="path-picker__list">
                {data.parent && (
                  <li>
                    <button type="button" onClick={() => setCwd(data.parent!)}>
                      ../
                    </button>
                  </li>
                )}
                {data.entries.map((entry) =>
                  entry.isDir ? (
                    <li key={entry.name}>
                      <button type="button" onClick={() => setCwd(`${data.path}/${entry.name}`)}>
                        {entry.name}/
                      </button>
                    </li>
                  ) : (
                    <li key={entry.name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked.includes(`${data.path}/${entry.name}`)}
                          onChange={(e) => {
                            const full = `${data.path}/${entry.name}`;
                            setChecked((prev) =>
                              e.target.checked ? [...prev, full] : prev.filter((p) => p !== full),
                            );
                          }}
                        />
                        {entry.name}
                      </label>
                    </li>
                  ),
                )}
              </ul>
              {data.entries.length === 0 && <p>No selectable entries here.</p>}
              {data.truncated && <p>Showing the first entries only — this directory has more.</p>}
              {mode === "directory" ? (
                <button
                  type="button"
                  onClick={() => {
                    onPick([data.path]);
                    setBrowsing(false);
                  }}
                >
                  Use this directory
                </button>
              ) : (
                <button
                  type="button"
                  disabled={checked.length === 0}
                  onClick={() => {
                    onPick(checked);
                    setBrowsing(false);
                  }}
                >
                  {`Use ${checked.length} selected file${checked.length === 1 ? "" : "s"}`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
