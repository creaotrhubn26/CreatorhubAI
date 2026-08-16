import type { GlimmerEvent } from "@glimmer/shared";

const TOOL_START_RE = /^→ TOOL: (\S+)$/;
const RESULT_RE = /^← RESULT:$/;
const BLOCKED_RE = /^✗ BLOCKED: (.+)$/;
const PEG_DEBUG_RE = /^\[PEG DEBUG\] payload: (.+)$/;
const ATTEMPT_RE = /-attempt-(\d+)\.json$/;
// ponytail: best-effort stdout-banner denylist, not airtight — the real fix is
// glimmer-v2.py/glimmer-engineer.py emitting structured JSON events instead of
// prose; upgrade path is the same --json-events flag noted above.
const RESULT_STOP_RE = /^(GLIMMER:?$|═{5,}$|┌─|└─|↻ |⚠ |LOCAL POST-FLIGHT$|git (status|diff))/;

function summarize(text: string, maxLen = 200): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "…" : oneLine;
}

export function parseLogToEvents(sessionId: string, logText: string): GlimmerEvent[] {
  const lines = logText.split("\n");
  const events: GlimmerEvent[] = [];
  let seq = 0;
  const nextId = () => `evt_${sessionId}_${seq++}`;
  const timestamp = () => new Date(0).toISOString(); // real wall-clock timestamps require structured backend logging; see Task notes.

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const pegMatch = line.match(PEG_DEBUG_RE);
    if (pegMatch) {
      const attemptMatch = pegMatch[1].match(ATTEMPT_RE);
      events.push({
        id: nextId(), sessionId, timestamp: timestamp(),
        type: "parser_recovery", attempt: attemptMatch ? Number(attemptMatch[1]) : 0, payloadPath: pegMatch[1],
      });
      i++;
      continue;
    }

    const blockedMatch = line.match(BLOCKED_RE);
    if (blockedMatch) {
      const reasonLine = lines[i + 1]?.trim() ?? "";
      events.push({
        id: nextId(), sessionId, timestamp: timestamp(),
        type: "tool_blocked", command: blockedMatch[1], reason: reasonLine,
      });
      i += 2;
      continue;
    }

    const toolMatch = line.match(TOOL_START_RE);
    if (toolMatch) {
      const tool = toolMatch[1];
      let j = i + 1;
      const argLines: string[] = [];
      while (j < lines.length && !RESULT_RE.test(lines[j])) {
        argLines.push(lines[j]);
        j++;
      }
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(argLines.join("\n")); } catch { /* non-JSON args: leave empty */ }
      events.push({ id: nextId(), sessionId, timestamp: timestamp(), type: "tool_started", tool, args });

      if (RESULT_RE.test(lines[j])) {
        let k = j + 1;
        const resultLines: string[] = [];
        while (k < lines.length && !PEG_DEBUG_RE.test(lines[k]) && !TOOL_START_RE.test(lines[k]) && !BLOCKED_RE.test(lines[k]) && !RESULT_STOP_RE.test(lines[k])) {
          resultLines.push(lines[k]);
          k++;
        }
        events.push({
          id: nextId(), sessionId, timestamp: timestamp(),
          type: "tool_completed", tool, resultSummary: summarize(resultLines.join("\n")),
        });
        i = k;
        continue;
      }
      i = j;
      continue;
    }

    i++;
  }

  return events;
}
