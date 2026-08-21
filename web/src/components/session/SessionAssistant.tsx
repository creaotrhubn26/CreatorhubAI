import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { GlimmerSession } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const SUGGESTIONS = [
  "Why was this file chosen?",
  "Summarize the changes",
  "What did verification check?",
  "What risks remain?",
];

interface Turn {
  id: number;
  question: string;
  askedAt: string;
  answer?: string;
  error?: string;
  answeredAt?: string;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function SessionAssistant({ sessionId, session }: { sessionId: string; session?: GlimmerSession }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const askMutation = useMutation({
    mutationFn: (q: string) => glimmerApi.askSession(sessionId, q),
  });

  function ask(q: string) {
    if (!q || askMutation.isPending) return;
    const id = Date.now();
    setTurns((prev) => [...prev, { id, question: q, askedAt: new Date().toISOString() }]);
    setQuestion("");
    askMutation.mutate(q, {
      onSuccess: (data) => {
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, answer: data.answer, answeredAt: new Date().toISOString() } : t)));
      },
      onError: () => {
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, error: "Unavailable — the assistant could not answer that." } : t)));
      },
    });
  }

  const hasChanges = !!session?.changedFiles.length;
  // Line-count stats are optional on ChangedFile and this backend never
  // populates them today — showing "+0 -0" when they're simply absent would
  // read as "no lines changed" rather than "unknown", so only render the
  // stat once at least one file actually carries it.
  const hasLineStats = !!session?.changedFiles.some((f) => f.insertions !== undefined || f.deletions !== undefined);
  const totalInsertions = session?.changedFiles.reduce((sum, f) => sum + (f.insertions ?? 0), 0) ?? 0;
  const totalDeletions = session?.changedFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      {turns.length === 0 && <p className="chat-greeting">👋 Hi! Ask me about this session.</p>}
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Answers are generated from this session's real evidence — not a general chat.
      </p>

      <div className="chat-suggestions">
        <div className="chat-suggestions__label">Try these</div>
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chat-suggestion" onClick={() => ask(s)} disabled={askMutation.isPending}>
            {s}
          </button>
        ))}
      </div>

      {hasChanges && (
        <div className="chat-filecard" style={{ marginTop: "var(--space-3)" }}>
          <span className="mono chat-filecard__path">{session!.changedFiles[0].path}{session!.changedFiles.length > 1 ? ` +${session!.changedFiles.length - 1} more` : ""}</span>
          {hasLineStats && (
            <>
              <span className="mono chat-filecard__stat-add">+{totalInsertions}</span>
              <span className="mono chat-filecard__stat-del">-{totalDeletions}</span>
            </>
          )}
          <Link to={`/sessions/${sessionId}/diff`}>Review Changes</Link>
        </div>
      )}

      <div className="chat-thread" style={{ marginTop: "var(--space-3)" }}>
        {turns.map((t) => (
          <div key={t.id}>
            <div className="chat-bubble-row from-user">
              <div className="chat-bubble-meta">You <span>{timeLabel(t.askedAt)}</span></div>
              <div className="chat-bubble from-user">{t.question}</div>
            </div>
            <div className="chat-bubble-row from-assistant">
              <div className="chat-bubble-meta">
                <span className="chat-avatar-chip">MG</span> Muse Glimmer
                {t.answeredAt && <span>{timeLabel(t.answeredAt)}</span>}
              </div>
              {t.answer && (
                <div className="chat-bubble from-assistant">
                  {t.answer}
                  <span className="chat-bubble__provenance">Model output — not a deterministic fact</span>
                </div>
              )}
              {t.error && <div className="chat-bubble from-assistant">{t.error}</div>}
              {!t.answer && !t.error && <div className="chat-bubble from-assistant">Asking…</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input-row">
        <input
          placeholder="Ask about this session…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") ask(question); }}
        />
        <button onClick={() => ask(question)} disabled={!question || askMutation.isPending} aria-label="Ask">
          {askMutation.isPending ? "Asking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
