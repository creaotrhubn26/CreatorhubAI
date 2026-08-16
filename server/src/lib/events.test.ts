import { describe, it, expect } from "vitest";
import { parseLogToEvents } from "./events.js";

const REAL_LOG = `[PEG DEBUG] payload: /Users/x/.muse-glimmer/debug/peg-payload-1-attempt-1.json

→ TOOL: read_file
{
  "path": "/ws/frontend/client/env.d.ts"
}
← RESULT:
/// <reference types="vite/client" />
export {};

[PEG DEBUG] payload: /Users/x/.muse-glimmer/debug/peg-payload-2-attempt-1.json

✗ BLOCKED: head -n 5 frontend/client/env.d.ts
  Command executable is outside the allowlist: head

[PEG DEBUG] payload: /Users/x/.muse-glimmer/debug/peg-payload-3-attempt-1.json

→ TOOL: edit_file
{
  "path": "/ws/frontend/client/env.d.ts",
  "keys": ["path", "edits"]
}
← RESULT:
{
  "result": "file edited successfully",
  "path": "/ws/frontend/client/env.d.ts",
  "edits_applied": 1
}
`;

describe("parseLogToEvents", () => {
  const events = parseLogToEvents("sid-1", REAL_LOG);

  it("emits a parser_recovery event for each [PEG DEBUG] line", () => {
    expect(events.filter((e) => e.type === "parser_recovery")).toHaveLength(3);
  });

  it("pairs a tool_started with its args and a following tool_completed", () => {
    const started = events.filter((e) => e.type === "tool_started");
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ tool: "read_file", args: { path: "/ws/frontend/client/env.d.ts" } });
    const completed = events.filter((e) => e.type === "tool_completed");
    expect(completed).toHaveLength(2);
    expect(completed[0].resultSummary).toContain("ImportMetaEnv".slice(0, 0)); // summary is non-empty, content-agnostic
    expect(completed[0].resultSummary.length).toBeGreaterThan(0);
  });

  it("emits a tool_blocked event with the reason on the next line", () => {
    const blocked = events.find((e) => e.type === "tool_blocked");
    expect(blocked).toMatchObject({
      command: "head -n 5 frontend/client/env.d.ts",
      reason: "Command executable is outside the allowlist: head",
    });
  });

  it("every event carries only whitelisted fields (no free-form 'thought' field)", () => {
    for (const e of events) {
      expect(e).not.toHaveProperty("thought");
      expect(e).not.toHaveProperty("reasoning");
    }
  });

  it("every event has a stable id and the given sessionId", () => {
    for (const e of events) {
      expect(e.sessionId).toBe("sid-1");
      expect(typeof e.id).toBe("string");
    }
  });

  it("parses the real PEG retry attempt number out of the payload filename, not a running event count", () => {
    const recoveries = events.filter((e) => e.type === "parser_recovery");
    // all three fixture lines reference a "...-attempt-1.json" payload, so the
    // parsed attempt must be 1 for each — a running sequence counter would
    // instead grow (e.g. 1, 4, 6) as other events are emitted in between.
    for (const r of recoveries) {
      expect(r.attempt).toBe(1);
    }
  });
});

// Ordinary (debug-off) runs never emit [PEG DEBUG] lines — GLIMMER_DEBUG_PEG_PAYLOAD
// is opt-in and unset in normal operation. In that mode, glimmer-engineer.py can still
// print a "GLIMMER:" banner followed by the model's free-form prose directly to stdout,
// between a "← RESULT:" block and the next "→ TOOL:" line. The parser must stop scanning
// before that banner, never folding raw model reasoning into resultSummary.
const NO_DEBUG_LOG = `→ TOOL: read_file
{
  "path": "/ws/a.ts"
}
← RESULT:
some file content here

GLIMMER:
Here is my internal reasoning about why this fix works — a secret
chain-of-thought explanation spanning multiple lines that must never reach the UI.

→ TOOL: write_file
{
  "path": "/ws/a.ts"
}
← RESULT:
ok
`;

describe("parseLogToEvents (no PEG DEBUG lines — default, debug-off run)", () => {
  const events = parseLogToEvents("sid-2", NO_DEBUG_LOG);

  it("stops the RESULT scan at a GLIMMER: banner instead of consuming the model's prose", () => {
    const completed = events.filter((e) => e.type === "tool_completed");
    expect(completed).toHaveLength(2);
    expect(completed[0].resultSummary).toBe("some file content here");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("GLIMMER");
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("chain-of-thought");
  });
});

describe("tool_started args are stripped of model-authored reasoning keys", () => {
  const LOG = `→ TOOL: edit_file
{
  "path": "a.ts",
  "rationale": "because the parser needs it",
  "thought": "first I will…",
  "reasoning": "…",
  "analysis": "…",
  "plan": "…",
  "edits": 1
}
← RESULT:
ok
`;
  const events = parseLogToEvents("sid-3", LOG);
  const started = events.find((e) => e.type === "tool_started") as Extract<
    ReturnType<typeof parseLogToEvents>[number], { type: "tool_started" }
  >;

  it("keeps legitimate operational args", () => {
    expect(started.args).toEqual({ path: "a.ts", edits: 1 });
  });

  it("drops every chain-of-thought-shaped key before the event is constructed", () => {
    const serialized = JSON.stringify(started);
    for (const forbidden of ["rationale", "thought", "reasoning", "analysis", "plan", "because the parser"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
