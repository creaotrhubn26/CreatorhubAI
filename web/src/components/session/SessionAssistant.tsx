import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GlimmerSession } from "@glimmer/shared";
import { glimmerApi } from "../../api/client";
import { loadTurns, saveTurns, type Turn } from "../../state/assistantHistory";

const SUGGESTIONS = [
  "Why was this file chosen?",
  "Summarize the changes",
  "What did verification check?",
  "What risks remain?",
];

const UNAVAILABLE_MESSAGE = "Unavailable — the assistant could not answer that.";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function SessionAssistant({ sessionId, session }: { sessionId: string; session?: GlimmerSession }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(sessionId));
  const [pending, setPending] = useState(false);

  // The panel can be reused across sessions without unmounting, so history
  // is (re)loaded whenever the session id changes, not just on first mount.
  useEffect(() => {
    setTurns(loadTurns(sessionId));
  }, [sessionId]);

  // Persist on every turn change, including pending/errored turns — never
  // just the successful ones, so a reload mid-question doesn't silently drop
  // or fabricate what actually happened.
  useEffect(() => {
    saveTurns(sessionId, turns);
  }, [sessionId, turns]);

  function patchTurn(id: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function ask(q: string) {
    if (!q || pending) return;
    const id = Date.now();
    setTurns((prev) => [...prev, { id, question: q, askedAt: new Date().toISOString() }]);
    setQuestion("");
    setPending(true);
    let streamedAnyDelta = false;
    try {
      const answer = await glimmerApi.askSessionStream(sessionId, q, (delta) => {
        streamedAnyDelta = true;
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, answer: (t.answer ?? "") + delta } : t)));
      });
      patchTurn(id, { answer, answeredAt: new Date().toISOString() });
    } catch {
      if (streamedAnyDelta) {
        // Mid-stream failure (server already sent partial output, then an
        // error frame): show the same Unavailable copy as any other failure,
        // not a half-finished answer.
        patchTurn(id, { answer: undefined, error: UNAVAILABLE_MESSAGE });
      } else {
        // Streaming never got off the ground (connection-time failure) —
        // fall back once to the non-streaming endpoint before giving up.
        try {
          const data = await glimmerApi.askSession(sessionId, q);
          patchTurn(id, { answer: data.answer, answeredAt: new Date().toISOString() });
        } catch {
          patchTurn(id, { error: UNAVAILABLE_MESSAGE });
        }
      }
    } finally {
      setPending(false);
    }
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
          <button key={s} className="chat-suggestion" onClick={() => ask(s)} disabled={pending}>
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
        <button onClick={() => ask(question)} disabled={!question || pending} aria-label="Ask">
          {pending ? "Asking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
