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

// A turn with neither an answer nor an error is either genuinely in flight
// or an orphan: a reload mid-question, or a turn asked in a session that got
// switched away from before it resolved. On (re)load there is no live
// request behind it anymore, so it can never legitimately finish — resolve
// it to the same Unavailable copy as any other failure rather than leaving
// a permanent "Asking…" ghost.
function resolveStaleTurns(turns: Turn[]): Turn[] {
  return turns.map((t) => (t.answer === undefined && t.error === undefined ? { ...t, error: UNAVAILABLE_MESSAGE } : t));
}

interface AssistantState {
  sid: string;
  turns: Turn[];
}

function loadState(sessionId: string): AssistantState {
  return { sid: sessionId, turns: resolveStaleTurns(loadTurns(sessionId)) };
}

// Applies a turns-updater only if `prev` still belongs to `forSession` — an
// async callback (a delta, a completed answer, a fallback result) can land
// after the user has switched to viewing a different session, and must not
// write that stale content into the now-current session's state (which would
// then get saved under the wrong sessionStorage key).
function applyToSession(prev: AssistantState, forSession: string, fn: (turns: Turn[]) => Turn[]): AssistantState {
  return prev.sid === forSession ? { sid: prev.sid, turns: fn(prev.turns) } : prev;
}

export function SessionAssistant({ sessionId, session }: { sessionId: string; session?: GlimmerSession }) {
  const [question, setQuestion] = useState("");
  const [chatState, setChatState] = useState<AssistantState>(() => loadState(sessionId));
  const [pending, setPending] = useState(false);

  // The panel can be reused across sessions without unmounting. Resetting
  // during render (rather than in an effect) means the swap to the new
  // session's history is visible in the very render that picks up the new
  // sessionId — no stale-session frame is ever committed, and the save
  // effect below (keyed on chatState.sid, not the sessionId prop) never races a
  // save-on-change against this load.
  if (chatState.sid !== sessionId) {
    setChatState(loadState(sessionId));
  }

  // Persist on every turn change, including pending/errored turns — never
  // just the successful ones, so a reload mid-question doesn't silently drop
  // or fabricate what actually happened. Saves under chatState.sid (the state's own
  // session id), so it can only ever write a session's turns under that same
  // session's key.
  useEffect(() => {
    saveTurns(chatState.sid, chatState.turns);
  }, [chatState]);

  async function ask(q: string) {
    if (!q || pending) return;
    const id = Date.now();
    const forSession = sessionId;
    setChatState((prev) => applyToSession(prev, forSession, (turns) => [...turns, { id, question: q, askedAt: new Date().toISOString() }]));
    setQuestion("");
    setPending(true);
    let streamedAnyDelta = false;
    try {
      const answer = await glimmerApi.askSessionStream(forSession, q, (delta) => {
        streamedAnyDelta = true;
        setChatState((prev) => applyToSession(prev, forSession, (turns) =>
          turns.map((t) => (t.id === id ? { ...t, answer: (t.answer ?? "") + delta } : t))
        ));
      });
      setChatState((prev) => applyToSession(prev, forSession, (turns) =>
        turns.map((t) => (t.id === id ? { ...t, answer, answeredAt: new Date().toISOString() } : t))
      ));
    } catch (streamErr: any) {
      // The server tags "upstream already reported dead" errors distinctly
      // (a mid-stream or immediate error frame) — retrying via the
      // non-streaming endpoint would just hit the same dead upstream, so
      // only a connection-time failure to our OWN gateway (never reached the
      // server at all) is worth a fallback attempt.
      const upstreamReportedDead = streamErr?.name === "AssistantUpstreamError";
      if (streamedAnyDelta || upstreamReportedDead) {
        setChatState((prev) => applyToSession(prev, forSession, (turns) =>
          turns.map((t) => (t.id === id ? { ...t, answer: undefined, error: UNAVAILABLE_MESSAGE } : t))
        ));
      } else {
        try {
          const data = await glimmerApi.askSession(forSession, q);
          setChatState((prev) => applyToSession(prev, forSession, (turns) =>
            turns.map((t) => (t.id === id ? { ...t, answer: data.answer, answeredAt: new Date().toISOString() } : t))
          ));
        } catch {
          setChatState((prev) => applyToSession(prev, forSession, (turns) =>
            turns.map((t) => (t.id === id ? { ...t, error: UNAVAILABLE_MESSAGE } : t))
          ));
        }
      }
    } finally {
      setPending(false);
    }
  }

  const turns = chatState.sid === sessionId ? chatState.turns : [];
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
