import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { langFromPath } from "../../state/highlight";
import { HighlightedText } from "../common/HighlightedText";
import { EmptyState } from "../common/EmptyState";

// Task A3: read-only file viewer. Line numbers + the SAME tokenizer the diff
// screen uses (state/highlight.ts via common/HighlightedText) — no editor
// dependency, and deliberately no editing affordance: this cannot write, so
// offering a cursor or a Save button would be a lie about what it does.
//
// Every abnormal read is named rather than smoothed over:
//   * a failed read shows the gateway's own reason, never an empty document
//   * a binary file shows a notice, never decoded garbage
//   * a truncated file is banded top AND bottom, so scrolling to the end
//     cannot be mistaken for reaching the end of the file
//   * the header carries the time the bytes were actually fetched, so what is
//     on screen is never implicitly claimed to be current

// ponytail: past this many lines highlighting is switched off wholesale —
// same ceiling and same reason as DiffReviewScreen's 2000-line bail.
const HIGHLIGHT_LINE_CEILING = 2000;

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  // A trailing newline ends the last line; it is not a further empty line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function CodeViewer({ path, line }: { path: string; line?: number }) {
  const { data, error, isPending, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["fs-file", path],
    queryFn: () => glimmerApi.readFile({ path }),
    retry: false,
  });

  const lineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: "center" });
  }, [data, line]);

  const name = path.split("/").pop() || path;

  if (isPending) return <div className="code-view__status">Loading {name}…</div>;
  if (error) {
    return (
      <div className="code-view">
        <div className="code-view__header">
          <span className="mono code-view__path">{path}</span>
        </div>
        <p role="alert" className="code-view__status">
          Could not read this file — {(error as Error).message}
        </p>
        <button type="button" onClick={() => refetch()}>Try again</button>
      </div>
    );
  }

  const lines = data.content === null ? [] : splitLines(data.content);
  const lang = lines.length > HIGHLIGHT_LINE_CEILING ? "plain" : langFromPath(path);

  return (
    <div className="code-view">
      <div className="code-view__header">
        <span className="mono code-view__path" title={path}>{path}</span>
        <span className="code-view__meta">
          {data.size.toLocaleString()} bytes · read {new Date(dataUpdatedAt).toLocaleTimeString()}
        </span>
        <button type="button" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Reloading…" : "Reload"}
        </button>
      </div>

      {data.binary ? (
        <EmptyState icon="▢" text={`Binary file — not shown (${data.size.toLocaleString()} bytes on disk).`} />
      ) : (
        <>
          {data.truncated && (
            <p className="code-view__notice" role="status">
              Truncated: showing the first {data.bytesReturned.toLocaleString()} of {data.size.toLocaleString()} bytes.
              The rest of this file was not read.
            </p>
          )}
          {data.size === 0 && <p className="code-view__notice">This file is empty (0 bytes).</p>}
          {/* A requested line the excerpt doesn't reach is said out loud —
              silently landing at the top would read as "line N is line 1". */}
          {line !== undefined && line > lines.length && (
            <p className="code-view__notice" role="status">
              Line {line} is past the {lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}
              {data.truncated ? " read from this file" : " in this file"} — not shown.
            </p>
          )}
          {lang === "plain" && lines.length > HIGHLIGHT_LINE_CEILING && (
            <p className="code-view__notice">
              Syntax highlighting is off for files over {HIGHLIGHT_LINE_CEILING.toLocaleString()} lines.
            </p>
          )}
          <div className="code-view__body">
            {lines.map((text, i) => {
              const no = i + 1;
              const isCurrent = line === no;
              return (
                <div
                  key={i}
                  ref={isCurrent ? lineRef : undefined}
                  className={`code-view__line${isCurrent ? " is-current" : ""}`}
                  data-line={no}
                >
                  <span className="code-view__lineno">{no}</span>
                  <span className="code-view__text">
                    <HighlightedText text={text} lang={lang} />
                  </span>
                </div>
              );
            })}
          </div>
          {data.truncated && (
            <p className="code-view__notice" role="status">
              — end of the truncated excerpt, not the end of the file —
            </p>
          )}
        </>
      )}
    </div>
  );
}
