import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

type DiffLineKind = "add" | "del" | "context" | "hunk" | "file";
interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

// Presentational parsing of a unified diff we already fetch verbatim from
// the gateway — no new data, just line-number bookkeeping + +/- tinting so
// it reads like an editor diff instead of a raw text blob.
function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, "").split("\n");
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
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
      out.push({ kind: "hunk", text: raw });
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

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div>Unavailable</div>;
  const lines = parseUnifiedDiff(diff);
  return (
    <div className="diff-view">
      {lines.map((l, i) => {
        if (l.kind === "file") return <div key={i} className="diff-view__file">{l.text}</div>;
        if (l.kind === "hunk") return <div key={i} className="diff-view__hunk">{l.text}</div>;
        const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
        return (
          <div key={i} className={`diff-view__line${l.kind !== "context" ? ` ${l.kind}` : ""}`}>
            <span className="diff-view__lineno">{l.oldNo ?? ""}</span>
            <span className="diff-view__lineno">{l.newNo ?? ""}</span>
            <span className="diff-view__marker">{marker}</span>
            <span className="diff-view__text">{l.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DiffReviewScreen() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { data: session } = useQuery({ queryKey: ["session", id], queryFn: () => glimmerApi.getSession(id!), enabled: !!id });
  const { data: diffResult } = useQuery({ queryKey: ["diff", id], queryFn: () => glimmerApi.getSessionDiff(id!), enabled: !!id });
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
  const humanAcceptance = session?.humanAcceptance;

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
        <button className="btn-primary" onClick={() => acceptMutation.mutate()} disabled={acceptMutation.isPending}>
          Accept for review
        </button>
      )}
      {acceptMutation.isError && <div>Unavailable — could not accept this session.</div>}
      <ul>
        {session?.changedFiles.map((f) => (
          <li key={f.path} className="row">
            M {f.path}{" "}
            <button onClick={() => revertMutation.mutate(f.path)} disabled={revertMutation.isPending}>
              Revert
            </button>
          </li>
        )) ?? <li>Unavailable</li>}
      </ul>
      {revertMutation.isError && <div>Unavailable — could not revert this file.</div>}
      <DiffView diff={diffResult?.diff ?? ""} />
    </div>
  );
}
