import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { askSessionAssistant } from "./sessionAssistant.js";
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
