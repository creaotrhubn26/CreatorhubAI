import { useEffect, useRef, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { useSharedSessionEvents } from "../../api/useSessionEvents";
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

function lineNumberForNode(node: Node | null, body: HTMLElement): number | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>(".code-view__line");
  if (!row || !body.contains(row)) return null;
  const value = Number(row.dataset.line);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function fileEventMatches(
  openPath: string,
  workspace: string | undefined,
  eventPath: string,
): boolean {
  if (eventPath.startsWith("/")) return eventPath === openPath;
  if (!workspace) return false;
  return `${workspace.replace(/\/+$/, "")}/${eventPath.replace(/^\.\//, "")}` === openPath;
}

export function CodeViewer({
  path,
  line,
  selectionStart,
  selectionEnd,
  workspace,
  onSelectionChange,
}: {
  path: string;
  line?: number;
  selectionStart?: number;
  selectionEnd?: number;
  workspace?: string;
  onSelectionChange?: (startLine: number, endLine: number) => void;
}) {
  const { data, error, isPending, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["fs-file", path],
    queryFn: () => glimmerApi.readFile({ path }),
    retry: false,
  });

  const lineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: "center" });
  }, [data, line]);

  // Round B / Task B3: the Files route can retain a session id in its query
  // string, so AppShell keeps that session's one shared SSE stream alive.
  // Re-read only when a NEW file_changed event names this exact open file;
  // replayed events carry the same id and are ignored. Accept/reject remains
  // in Diff Review — this is only a read refresh.
  const events = useSharedSessionEvents();
  const lastHandledFileEvent = useRef<string | null>(null);
  useEffect(() => {
    const changed = [...events]
      .reverse()
      .find(
        (event) => event.type === "file_changed" && fileEventMatches(path, workspace, event.path),
      );
    if (!changed || changed.id === lastHandledFileEvent.current) return;
    lastHandledFileEvent.current = changed.id;
    void refetch();
  }, [events, path, workspace, refetch]);

  const name = path.split("/").pop() || path;

  function captureSelection(event: MouseEvent<HTMLDivElement>) {
    if (!onSelectionChange) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const start = lineNumberForNode(selection.anchorNode, event.currentTarget);
    const end = lineNumberForNode(selection.focusNode, event.currentTarget);
    if (start === null || end === null) return;
    onSelectionChange(Math.min(start, end), Math.max(start, end));
  }

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
        <button type="button" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const lines = data.content === null ? [] : splitLines(data.content);
  const lang = lines.length > HIGHLIGHT_LINE_CEILING ? "plain" : langFromPath(path);

  return (
    <div className="code-view">
      <div className="code-view__header">
        <span className="mono code-view__path" title={path}>
          {path}
        </span>
        <span className="code-view__meta">
          {data.size.toLocaleString()} bytes · read {new Date(dataUpdatedAt).toLocaleTimeString()}
        </span>
        <button type="button" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Reloading…" : "Reload"}
        </button>
      </div>

      {data.binary ? (
        <EmptyState
          icon="▢"
          text={`Binary file — not shown (${data.size.toLocaleString()} bytes on disk).`}
        />
      ) : (
        <>
          {data.truncated && (
            <p className="code-view__notice" role="status">
              Truncated: showing the first {data.bytesReturned.toLocaleString()} of{" "}
              {data.size.toLocaleString()} bytes. The rest of this file was not read.
            </p>
          )}
          {data.size === 0 && <p className="code-view__notice">This file is empty (0 bytes).</p>}
          {/* A requested line the excerpt doesn't reach is said out loud —
              silently landing at the top would read as "line N is line 1". */}
          {line !== undefined && line > lines.length && (
            <p className="code-view__notice" role="status">
              Line {line} is past the {lines.length.toLocaleString()} line
              {lines.length === 1 ? "" : "s"}
              {data.truncated ? " read from this file" : " in this file"} — not shown.
            </p>
          )}
          {lang === "plain" && lines.length > HIGHLIGHT_LINE_CEILING && (
            <p className="code-view__notice">
              Syntax highlighting is off for files over {HIGHLIGHT_LINE_CEILING.toLocaleString()}{" "}
              lines.
            </p>
          )}
          <div className="code-view__body" onMouseUp={captureSelection}>
            {lines.map((text, i) => {
              const no = i + 1;
              const isCurrent = line === no;
              const isSelected =
                selectionStart !== undefined &&
                selectionEnd !== undefined &&
                no >= selectionStart &&
                no <= selectionEnd;
              return (
                <div
                  key={i}
                  ref={isCurrent ? lineRef : undefined}
                  className={`code-view__line${isCurrent ? " is-current" : ""}${isSelected ? " is-selected" : ""}`}
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
