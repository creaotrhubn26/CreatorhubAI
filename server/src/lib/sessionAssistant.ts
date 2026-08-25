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
  // V7 §18: recommended checks run but never gate — label them so the
  // assistant's evidence stays complete without conflating tiers.
  for (const c of session.verification.recommendedChecks ?? []) {
    lines.push(`  - ${c.command}: ${c.status} (recommended, non-gating)`);
  }
  for (const e of events) {
    if (e.type === "tool_blocked") lines.push(`Blocked: ${e.command} — ${e.reason}`);
    if (e.type === "candidate_selected") lines.push(`Selected ${e.file}: ${e.reasons.join(", ")}`);
    // M3 (followup-1-2 review): don't summarize a human-approved
    // expansion identically to an unreviewed one -- the assistant's
    // evidence text feeds a model, so an honest distinction here matters
    // exactly the same way it does in AgentTimeline's own rendering.
    if (e.type === "scope_expanded") {
      const approval = e.approved ? ` (human-approved${e.approvedBy ? ` by ${e.approvedBy}` : ""})` : "";
      lines.push(`Scope expanded${approval} — expected ${e.expected.join(", ")}, actual ${e.actual.join(", ")}`);
    }
  }
  return lines.join("\n");
}

// Deliberately no `tools`/`functions` field: this request is architecturally
// incapable of triggering a tool call, regardless of what the model outputs.
// The read-only guarantee (spec §20) does not depend on the model obeying the
// system prompt below.
interface AssistantContext {
  kind: "session" | "repository selection";
  label: "Session evidence" | "Repository evidence";
  evidence: string;
}

function buildMessages(context: AssistantContext, question: string) {
  return [
    {
      role: "system",
      content:
        `You are a read-only assistant explaining a Glimmer ${context.kind}. ` +
        `Answer only from the ${context.kind} evidence given to you. You cannot modify files, run ` +
        "commands, or take any action — only explain, summarize, and answer questions about what " +
        "the evidence contains.",
    },
    { role: "user", content: `${context.label}:\n${context.evidence}\n\nQuestion: ${question}` },
  ];
}

async function askAssistant(
  modelBaseUrl: string,
  context: AssistantContext,
  question: string,
  timeoutMs: number
): Promise<SessionAssistantAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${modelBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      // Deliberately no `tools`/`functions` field — this is the architectural
      // read-only boundary for BOTH session and repository-selection asks.
      body: JSON.stringify({ model: "muse-glimmer", messages: buildMessages(context, question) }),
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

export async function askSessionAssistant(
  modelBaseUrl: string,
  session: GlimmerSession,
  events: GlimmerEvent[],
  question: string,
  timeoutMs = 30_000
): Promise<SessionAssistantAnswer> {
  return askAssistant(
    modelBaseUrl,
    { kind: "session", label: "Session evidence", evidence: summarizeEvidence(session, events) },
    question,
    timeoutMs,
  );
}

export function askRepositoryAssistant(
  modelBaseUrl: string,
  evidence: string,
  question: string,
  timeoutMs = 30_000,
): Promise<SessionAssistantAnswer> {
  return askAssistant(
    modelBaseUrl,
    { kind: "repository selection", label: "Repository evidence", evidence },
    question,
    timeoutMs,
  );
}

// Streaming variant: forwards `stream: true` upstream (OpenAI-compatible SSE:
// `data: {...choices[0].delta.content...}` lines, terminated by `data:
// [DONE]`), invoking onDelta as each chunk of text arrives. Returns the full
// concatenated answer once the upstream stream ends. Same evidence/messages
// as askSessionAssistant — only `stream` and the response handling differ.
//
// `signal`, when passed, is combined with our own idle-timeout controller
// (see below) so the caller (the route handler) can abort the upstream
// request the moment its own client disconnects, instead of leaving it
// running to completion for nothing.
async function streamAssistant(
  modelBaseUrl: string,
  context: AssistantContext,
  question: string,
  onDelta: (delta: string) => void,
  timeoutMs = 30_000,
  signal?: AbortSignal
): Promise<string> {
  // Idle timeout, not one wall-clock deadline: a slow-but-steady stream of
  // deltas must not be killed just because the whole answer takes longer
  // than timeoutMs to finish — only actual silence (no delta at all) for
  // timeoutMs should abort it. Reset on every delta received.
  const idleController = new AbortController();
  let idleTimer = setTimeout(() => idleController.abort(), timeoutMs);
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), timeoutMs);
  }
  const combinedSignal = signal ? AbortSignal.any([idleController.signal, signal]) : idleController.signal;

  let full = "";
  // Shared by the in-loop parse and the final flush below (item 7: a stream
  // that ends without a trailing "\n\n" must not silently drop its last
  // frame) so both paths process a `data: ...` line identically.
  function processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // malformed/torn SSE chunk — skip rather than crash the stream
    }
    const delta = parsed?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      resetIdleTimer();
      full += delta;
      onDelta(delta);
    }
  }

  try {
    const res = await fetch(`${modelBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: combinedSignal,
      // Same no-tools boundary as askAssistant above; streaming changes only
      // transport, never the model's capabilities.
      body: JSON.stringify({ model: "muse-glimmer", stream: true, messages: buildMessages(context, question) }),
    });
    if (!res.ok || !res.body) throw new Error(`model request failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // last entry may be a partial line split across chunks
      for (const line of lines) processLine(line);
    }
    processLine(buffer); // flush a final frame with no trailing newline

    if (!full) throw new Error("model returned no usable answer");
    return full;
  } finally {
    clearTimeout(idleTimer);
  }
}

export function streamSessionAssistant(
  modelBaseUrl: string,
  session: GlimmerSession,
  events: GlimmerEvent[],
  question: string,
  onDelta: (delta: string) => void,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  return streamAssistant(
    modelBaseUrl,
    { kind: "session", label: "Session evidence", evidence: summarizeEvidence(session, events) },
    question,
    onDelta,
    timeoutMs,
    signal,
  );
}

export function streamRepositoryAssistant(
  modelBaseUrl: string,
  evidence: string,
  question: string,
  onDelta: (delta: string) => void,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  return streamAssistant(
    modelBaseUrl,
    { kind: "repository selection", label: "Repository evidence", evidence },
    question,
    onDelta,
    timeoutMs,
    signal,
  );
}
