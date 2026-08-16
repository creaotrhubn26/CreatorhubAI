import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

export function SessionAssistant({ sessionId }: { sessionId: string }) {
  const [question, setQuestion] = useState("");
  const askMutation = useMutation({ mutationFn: (q: string) => glimmerApi.askSession(sessionId, q) });

  return (
    <fieldset>
      <legend>Ask about this session</legend>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Answers are generated from this session's real evidence — not a general chat.
      </p>
      <input
        placeholder="Ask about this session…"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <button onClick={() => askMutation.mutate(question)} disabled={!question || askMutation.isPending}>
        {askMutation.isPending ? "Asking…" : "Ask"}
      </button>
      {askMutation.isSuccess && (
        <div>
          <p>{askMutation.data.answer}</p>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Model output — not a deterministic fact</span>
        </div>
      )}
      {askMutation.isError && <div>Unavailable — the assistant could not answer that.</div>}
    </fieldset>
  );
}
