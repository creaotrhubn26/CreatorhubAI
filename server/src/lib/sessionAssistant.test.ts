import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import {
  askRepositoryAssistant, askSessionAssistant, streamRepositoryAssistant, streamSessionAssistant,
} from "./sessionAssistant.js";
import type { GlimmerSession, GlimmerEvent } from "@glimmer/shared";

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const SESSION: GlimmerSession = {
  id: "s1", task: "Fix dialog parser", status: "verified", workspace: "/ws", branch: "glimmer/x",
  baselineSha: "abc", changedFiles: [{ path: "DialogParser.ts", status: "modified" }],
  verification: { overall: "VERIFIED", checks: [{ command: "npm run typecheck", status: "PASS", ok: true, returncode: 0, elapsedSeconds: 1, outputTail: "", baselineAware: false, newErrorSignatures: [] }] },
  repairsUsed: 0, repairBudget: 2,
  finalStatus: { functional: "VERIFIED", visual: "not_run", architecture: "not_run", documentation: "not_run" },
};
const EVENTS: GlimmerEvent[] = [
  { id: "e1", sessionId: "s1", timestamp: "t", type: "candidate_selected", file: "DialogParser.ts", reasons: ["owns parser state"] },
];

describe("askSessionAssistant", () => {
  it("sends a request with NO tools/functions field, even though it can", async () => {
    let receivedBody: any;
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "It owns the parser state." } }] }));
      });
    });
    await askSessionAssistant(url, SESSION, EVENTS, "Why was DialogParser.ts chosen?");
    expect(receivedBody).not.toHaveProperty("tools");
    expect(receivedBody).not.toHaveProperty("functions");
    expect(receivedBody.messages[1].content).toContain("Why was DialogParser.ts chosen?");
    expect(receivedBody.messages[1].content).toContain("DialogParser.ts"); // real evidence, not fabricated
  });

  it("returns the model's answer with model-output provenance", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "It owns the parser state." } }] }));
    });
    const result = await askSessionAssistant(url, SESSION, EVENTS, "Why?");
    expect(result).toEqual({ answer: "It owns the parser state.", provenance: "model-output" });
  });

  it("throws a clear error when the model is unreachable, rather than hanging", async () => {
    await expect(askSessionAssistant("http://127.0.0.1:1", SESSION, EVENTS, "Why?", 500)).rejects.toThrow();
  });

  it("throws when the model responds but with no usable answer", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [] }));
    });
    await expect(askSessionAssistant(url, SESSION, EVENTS, "Why?")).rejects.toThrow();
  });
});

describe("repository selection assistant", () => {
  const evidence = [
    "File: /w/src/a.ts",
    "Lines: 3-5",
    "--- begin selected lines ---",
    "return parse(input);",
    "--- end selected lines ---",
  ].join("\n");

  it("labels repository evidence and still sends no tools/functions field", async () => {
    let receivedBody: any;
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "It parses the selected input." } }] }));
      });
    });
    const result = await askRepositoryAssistant(url, evidence, "What does this do?");
    expect(result.answer).toBe("It parses the selected input.");
    expect(receivedBody).not.toHaveProperty("tools");
    expect(receivedBody).not.toHaveProperty("functions");
    expect(receivedBody.messages[1].content).toContain("Repository evidence:");
    expect(receivedBody.messages[1].content).toContain("File: /w/src/a.ts");
    expect(receivedBody.messages[1].content).toContain("Lines: 3-5");
  });

  it("streams repository evidence through the same tool-less transport", async () => {
    let receivedBody: any;
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Selected answer" } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    const answer = await streamRepositoryAssistant(url, evidence, "Why?", () => {});
    expect(answer).toBe("Selected answer");
    expect(receivedBody).not.toHaveProperty("tools");
    expect(receivedBody).not.toHaveProperty("functions");
    expect(receivedBody.messages[1].content).toContain("Repository evidence:");
  });
});

describe("streamSessionAssistant", () => {
  it("streams each delta and resolves with the full concatenated answer", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "It owns " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "the parser state." } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const deltas: string[] = [];
    const answer = await streamSessionAssistant(url, SESSION, EVENTS, "Why?", (d) => deltas.push(d));
    expect(deltas).toEqual(["It owns ", "the parser state."]);
    expect(answer).toBe("It owns the parser state.");
  });

  it("flushes a final frame with no trailing newline instead of dropping it", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // No trailing "\n\n" — the connection just ends right after this frame.
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "It owns the parser state." } }] })}`);
    });
    const deltas: string[] = [];
    const answer = await streamSessionAssistant(url, SESSION, EVENTS, "Why?", (d) => deltas.push(d));
    expect(deltas).toEqual(["It owns the parser state."]);
    expect(answer).toBe("It owns the parser state.");
  });

  it("throws instead of resolving when the concatenated answer is empty (upstream sent only [DONE])", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
    await expect(streamSessionAssistant(url, SESSION, EVENTS, "Why?", () => {})).rejects.toThrow(/no usable answer/);
  });

  it("aborts the upstream request when the caller's signal fires (client disconnected)", async () => {
    let upstreamAborted = false;
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      req.on("close", () => { upstreamAborted = true; });
      // Never ends on its own — only the caller's signal (or a timeout) ends this.
    });
    const callerGone = new AbortController();
    setTimeout(() => callerGone.abort(), 30);
    await expect(
      streamSessionAssistant(url, SESSION, EVENTS, "Why?", () => {}, 30_000, callerGone.signal)
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20)); // let the server-side 'close' event land
    expect(upstreamAborted).toBe(true);
  });

  it("does not abort a slow-but-steady stream whose total duration exceeds the idle timeout, as long as gaps between deltas stay under it", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${n} ` } }] })}\n\n`);
        if (n === 3) {
          clearInterval(timer);
          res.end("data: [DONE]\n\n");
        }
      }, 40); // 3 deltas, 40ms apart => ~120ms total, well over a 60ms idle timeout
    });
    const answer = await streamSessionAssistant(url, SESSION, EVENTS, "Why?", () => {}, 60);
    expect(answer).toBe("1 2 3 ");
  });

  it("aborts when the upstream goes idle (no delta at all) for longer than the idle timeout", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      // Then goes silent well past the idle timeout before ever sending [DONE].
      setTimeout(() => res.end("data: [DONE]\n\n"), 200);
    });
    await expect(streamSessionAssistant(url, SESSION, EVENTS, "Why?", () => {}, 50)).rejects.toThrow();
  });
});
