import type { GlimmerSession, GlimmerEvent, SessionAssistantAnswer } from "@glimmer/shared";

function summarizeEvidence(session: GlimmerSession, events: GlimmerEvent[]): string {
  const lines: string[] = [];
  lines.push(`Task: ${session.task}`);
  lines.push(`Status: ${session.status}`);
  lines.push(`Changed files: ${session.changedFiles.map((f) => f.path).join(", ") || "none"}`);
  lines.push(`Verification: ${session.verification.overall}`);
  for (const c of session.verification.checks) {
    const newErrors = c.newErrorSignatures.length ? ` (new errors: ${c.newErrorSignatures.join("; ")})` : "";
    lines.push(`  - ${c.command}: ${c.status}${newErrors}`);
  }
  for (const e of events) {
    if (e.type === "tool_blocked") lines.push(`Blocked: ${e.command} — ${e.reason}`);
    if (e.type === "candidate_selected") lines.push(`Selected ${e.file}: ${e.reasons.join(", ")}`);
    if (e.type === "scope_expanded") lines.push(`Scope expanded — expected ${e.expected.join(", ")}, actual ${e.actual.join(", ")}`);
  }
  return lines.join("\n");
}

export async function askSessionAssistant(
  modelBaseUrl: string,
  session: GlimmerSession,
  events: GlimmerEvent[],
  question: string,
  timeoutMs = 30_000
): Promise<SessionAssistantAnswer> {
  const evidence = summarizeEvidence(session, events);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${modelBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      // Deliberately no `tools`/`functions` field: this request is
      // architecturally incapable of triggering a tool call, regardless of
      // what the model outputs. The read-only guarantee (spec §20) does not
      // depend on the model obeying the system prompt below.
      body: JSON.stringify({
        model: "muse-glimmer",
        messages: [
          {
            role: "system",
            content:
              "You are a read-only assistant explaining a completed or in-progress Glimmer engineering " +
              "session. Answer only from the session evidence given to you. You cannot modify files, run " +
              "commands, or take any action — only explain, summarize, and answer questions about what " +
              "already happened.",
          },
          { role: "user", content: `Session evidence:\n${evidence}\n\nQuestion: ${question}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`model request failed: ${res.status}`);
    const body = await res.json();
    const answer = body?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer) throw new Error("model returned no usable answer");
    return { answer, provenance: "model-output" };
  } finally {
    clearTimeout(timer);
  }
}
