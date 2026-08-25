import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { langFromPath, type Lang } from "../../state/highlight";
import { HighlightedText } from "../common/HighlightedText";
import { absolutePath, fileHref } from "../../state/fileLink";
import type { DiffReviewHunk } from "@glimmer/shared";

type DiffLineKind = "add" | "del" | "context" | "hunk" | "file";
interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  reviewIndex?: number;
}

// Presentational parsing of a unified diff we already fetch verbatim from
// the gateway — no new data, just line-number bookkeeping + +/- tinting so
// it reads like an editor diff instead of a raw text blob.
function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, "").split("\n");
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let reviewIndex = -1;
  for (const raw of lines) {
    if (
      raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") ||
      raw.startsWith("new file mode") || raw.startsWith("old mode") || raw.startsWith("new mode") ||
      raw.startsWith("deleted file mode") || raw.startsWith("similarity index") || raw.startsWith("rename from") ||
      raw.startsWith("rename to") || raw.startsWith("copy from") || raw.startsWith("copy to") ||
      raw.startsWith("Binary files") || raw.startsWith("\\ No newline")
    ) {
      out.push({ kind: "file", text: raw });
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw, reviewIndex: ++reviewIndex });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else {
      out.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

interface DiffFileGroup {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

function extractPath(groupLines: DiffLine[]): string {
  for (const l of groupLines) {
    if (l.kind === "file" && l.text.startsWith("+++ ")) {
      const raw = l.text.slice(4).trim();
      if (raw && raw !== "/dev/null") return raw.replace(/^b\//, "");
    }
  }
  for (const l of groupLines) {
    if (l.kind === "file" && l.text.startsWith("diff --git")) {
      const m = l.text.match(/ b\/(.+)$/);
      if (m) return m[1];
    }
  }
  return "file";
}

// Groups the flat parsed-line stream into one section per file (split on
// "diff --git" boundaries), with real +N/-M counts computed from the parsed
// lines themselves — so the sticky per-file header is never a guess.
function groupLinesByFile(lines: DiffLine[]): DiffFileGroup[] {
  const groups: DiffFileGroup[] = [];
  let current: DiffLine[] = [];
  function flush() {
    if (current.length === 0) return;
    const added = current.filter((l) => l.kind === "add").length;
    const removed = current.filter((l) => l.kind === "del").length;
    groups.push({ path: extractPath(current), added, removed, lines: current });
    current = [];
  }
  for (const l of lines) {
    if (l.kind === "file" && l.text.startsWith("diff --git")) flush();
    current.push(l);
  }
  flush();
  return groups;
}

function HunkHeader({
  line, hunk, busy, onAccept, onReject,
}: {
  line: DiffLine;
  hunk?: DiffReviewHunk;
  busy: boolean;
  onAccept: (hunk: DiffReviewHunk) => void;
  onReject: (hunk: DiffReviewHunk) => void;
}) {
  if (!hunk) return <div className="diff-view__hunk">{line.text}</div>;
  return (
    <div className={`diff-view__hunk${hunk.status === "accepted" ? " accepted" : ""}`}>
      <span>{line.text}</span>
      <span className="diff-view__hunk-stats">+{hunk.added} -{hunk.removed}</span>
      <span className="diff-view__hunk-status">{hunk.status === "accepted" ? "Accepted" : "Pending review"}</span>
      <button
        type="button"
        aria-label={`Accept hunk in ${hunk.path}: ${hunk.header}`}
        disabled={busy || hunk.status === "accepted"}
        onClick={() => onAccept(hunk)}
      >
        Accept hunk
      </button>
      <button
        type="button"
        aria-label={`Reject hunk in ${hunk.path}: ${hunk.header}`}
        disabled={busy}
        onClick={() => onReject(hunk)}
      >
        Reject hunk
      </button>
    </div>
  );
}

function UnifiedLine({
  l, lang, hunk, busy = false, onAccept = () => {}, onReject = () => {},
}: {
  l: DiffLine;
  lang: Lang;
  hunk?: DiffReviewHunk;
  busy?: boolean;
  onAccept?: (hunk: DiffReviewHunk) => void;
  onReject?: (hunk: DiffReviewHunk) => void;
}) {
  if (l.kind === "file") return <div className="diff-view__file">{l.text}</div>;
  if (l.kind === "hunk") return (
    <HunkHeader line={l} hunk={hunk} busy={busy} onAccept={onAccept} onReject={onReject} />
  );
  const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
  return (
    <div className={`diff-view__line${l.kind !== "context" ? ` ${l.kind}` : ""}`}>
      <span className="diff-view__lineno">{l.oldNo ?? ""}</span>
      <span className="diff-view__lineno">{l.newNo ?? ""}</span>
      <span className="diff-view__marker">{marker}</span>
      <span className="diff-view__text">
        <HighlightedText text={l.text} lang={lang} />
      </span>
    </div>
  );
}

type SplitRow = { type: "full"; line: DiffLine } | { type: "pair"; left?: DiffLine; right?: DiffLine };

// §14 side-by-side: same parsed unified diff, hunk-aligned with a simple
// zip of consecutive del/add runs — context lines mirror on both sides,
// del-only/add-only lines leave the opposite cell blank. No new data.
function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  function flushChange() {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ type: "pair", left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  }
  for (const l of lines) {
    if (l.kind === "del") { dels.push(l); continue; }
    if (l.kind === "add") { adds.push(l); continue; }
    flushChange();
    if (l.kind === "context") rows.push({ type: "pair", left: l, right: l });
    else rows.push({ type: "full", line: l });
  }
  flushChange();
  return rows;
}

function SplitCell({ line, side, lang }: { line?: DiffLine; side: "del" | "add"; lang: Lang }) {
  if (!line) return <div className={`diff-view__side diff-view__side--${side === "add" ? "right" : "left"} empty`} />;
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const lineNo = side === "add" ? line.newNo : line.oldNo;
  return (
    <div className={`diff-view__side diff-view__side--${side === "add" ? "right" : "left"}${line.kind !== "context" ? ` ${line.kind}` : ""}`}>
      <span className="diff-view__lineno">{lineNo ?? ""}</span>
      <span className="diff-view__marker">{marker}</span>
      <span className="diff-view__text">
        <HighlightedText text={line.text} lang={lang} />
      </span>
    </div>
  );
}

// Task A4: the new-side line the file's first hunk starts at, so the viewer
// opens where the change is. Undefined when the diff never stated one (a
// pure-rename/mode-change section has no hunk) — never a fabricated 1.
function firstChangedLine(lines: DiffLine[]): number | undefined {
  for (const l of lines) {
    if (l.kind === "add" || l.kind === "context") return l.newNo;
  }
  return undefined;
}

function DiffView({ diff, hunks, mode, wrap, workspace, sessionId, hunkBusy, onAcceptHunk, onRejectHunk }: {
  diff: string;
  hunks: DiffReviewHunk[];
  mode: "unified" | "split";
  wrap: boolean;
  workspace?: string;
  sessionId?: string;
  hunkBusy: boolean;
  onAcceptHunk: (hunk: DiffReviewHunk) => void;
  onRejectHunk: (hunk: DiffReviewHunk) => void;
}) {
  if (!diff) return <div>Unavailable</div>;
  const groups = groupLinesByFile(parseUnifiedDiff(diff));
  const className = `diff-view${mode === "split" ? " diff-view--split" : ""}${wrap ? " wrap" : ""}`;
  return (
    <div className={className}>
      {groups.map((g, gi) => {
        // ponytail: skip highlighting entirely for a giant generated/lockfile
        // dump — tokenizing 2000+ lines just to render them all in the same
        // muted color is wasted work, so treat the whole file group as plain.
        const lang = g.lines.length > 2000 ? "plain" : langFromPath(g.path);
        return (
          <div className="diff-view__filegroup" key={gi}>
            <div className="diff-view__file-header">
              {/* Opens the working-tree file in the read-only viewer. Only
                  when the session's workspace is known — without it there is
                  no absolute path to open, and guessing one would be a lie. */}
              {workspace ? (
                <Link className="mono" to={fileHref(absolutePath(workspace, g.path), firstChangedLine(g.lines), sessionId)}>
                  {g.path}
                </Link>
              ) : (
                <span className="mono">{g.path}</span>
              )}
              <span className="diff-view__stat-add">+{g.added}</span>
              <span className="diff-view__stat-del">-{g.removed}</span>
            </div>
            {mode === "unified"
              ? g.lines.map((l, i) => (
                  <UnifiedLine
                    l={l}
                    lang={lang}
                    hunk={l.reviewIndex === undefined ? undefined : hunks[l.reviewIndex]}
                    busy={hunkBusy}
                    onAccept={onAcceptHunk}
                    onReject={onRejectHunk}
                    key={i}
                  />
                ))
              : buildSplitRows(g.lines).map((r, i) =>
                  r.type === "full" ? (
                    <UnifiedLine
                      l={r.line}
                      lang={lang}
                      hunk={r.line.reviewIndex === undefined ? undefined : hunks[r.line.reviewIndex]}
                      busy={hunkBusy}
                      onAccept={onAcceptHunk}
                      onReject={onRejectHunk}
                      key={i}
                    />
                  ) : (
                    <div className="diff-view__split-row" key={i}>
                      <SplitCell line={r.left} side="del" lang={lang} />
                      <SplitCell line={r.right} side="add" lang={lang} />
                    </div>
                  )
                )}
          </div>
        );
      })}
    </div>
  );
}

export function DiffReviewScreen() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(false);
  const { data: session } = useQuery({ queryKey: ["session", id], queryFn: () => glimmerApi.getSession(id!), enabled: !!id });
  const { data: diffResult, isPending: diffPending } = useQuery({
    queryKey: ["diff", id], queryFn: () => glimmerApi.getSessionDiff(id!), enabled: !!id,
  });
  const revertMutation = useMutation({
    mutationFn: (path: string) => glimmerApi.revertFile(id!, path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", id] });
      queryClient.invalidateQueries({ queryKey: ["diff", id] });
      queryClient.invalidateQueries({ queryKey: ["session-analysis", id] });
    },
  });
  // §14 Diff Review: "accept for review" is a distinct human-judgment fact,
  // never something the model/orchestrator can set — see acceptSession in
  // api/client.ts and POST /sessions/:id/accept on the gateway.
  const acceptMutation = useMutation({
    mutationFn: () => glimmerApi.acceptSession(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session", id] }),
  });
  const acceptHunkMutation = useMutation({
    mutationFn: (hunk: DiffReviewHunk) => glimmerApi.acceptHunk(id!, hunk.id, hunk.path),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["diff", id] }),
  });
  const rejectHunkMutation = useMutation({
    mutationFn: (hunk: DiffReviewHunk) => glimmerApi.rejectHunk(id!, hunk.id, hunk.path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", id] });
      queryClient.invalidateQueries({ queryKey: ["diff", id] });
      queryClient.invalidateQueries({ queryKey: ["session-analysis", id] });
    },
  });
  const humanAcceptance = session?.humanAcceptance;
  const reviewHunks = diffResult?.hunks ?? [];
  const pendingHunks = reviewHunks.filter((hunk) => hunk.status !== "accepted").length;
  const hunkBusy = acceptHunkMutation.isPending || rejectHunkMutation.isPending;

  return (
    <div>
      <h1>Diff Review</h1>
      <p>
        Technical: {session?.verification?.overall ?? "Unavailable"} — Human review:{" "}
        {humanAcceptance?.accepted
          ? `Accepted ${new Date(humanAcceptance.acceptedAt).toLocaleString()}`
          : "Not yet accepted"}
      </p>
      {!humanAcceptance?.accepted && (
        <button
          className="btn-primary"
          onClick={() => acceptMutation.mutate()}
          disabled={acceptMutation.isPending || diffPending || pendingHunks > 0}
          title={diffPending ? "Loading diff review state" : pendingHunks > 0 ? `${pendingHunks} hunk(s) still need a decision` : undefined}
        >
          Accept for review
        </button>
      )}
      {pendingHunks > 0 && <p role="status">Review each hunk before accepting the complete diff — {pendingHunks} pending.</p>}
      {acceptMutation.isError && <div>Unavailable — could not accept this session.</div>}
      <ul>
        {session?.changedFiles.map((f) => (
          <li key={f.path} className="row">
            M {f.path}{" "}
            <button onClick={() => revertMutation.mutate(f.path)} disabled={revertMutation.isPending || hunkBusy}>
              Revert file
            </button>
          </li>
        )) ?? <li>Unavailable</li>}
      </ul>
      {revertMutation.isError && <div>Unavailable — could not revert this file.</div>}
      {acceptHunkMutation.isError && <div>Unavailable — could not accept this hunk. Refresh and review again.</div>}
      {rejectHunkMutation.isError && <div>Unavailable — could not reject this hunk. Refresh and review again.</div>}
      <div className="toolbar">
        <div role="tablist" aria-label="Diff view mode">
          {(["unified", "split"] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
        <button aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
          {wrap ? "Unwrap" : "Wrap"}
        </button>
      </div>
      <DiffView
        diff={diffResult?.diff ?? ""}
        hunks={reviewHunks}
        mode={mode}
        wrap={wrap}
        workspace={session?.workspace}
        sessionId={id}
        hunkBusy={hunkBusy}
        onAcceptHunk={(hunk) => acceptHunkMutation.mutate(hunk)}
        onRejectHunk={(hunk) => rejectHunkMutation.mutate(hunk)}
      />
    </div>
  );
}
