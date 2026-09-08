import { Router } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { CONFIG } from "../config.js";

/**
 * Browser bridge: lets the Glimmer verification loop see the user's REAL
 * browser (logged-in state, real console errors) through the companion
 * Chrome extension, instead of only the sterile headless capture in
 * glimmer-visual.py.
 *
 * Flow: glimmer-visual.py POSTs /browser/execute and blocks; the extension
 * long-polls GET /browser/poll, runs the command in Chrome, and POSTs
 * /browser/result, which resolves the waiting execute. Everything is
 * in-memory — a command outliving the gateway process is worthless anyway.
 *
 * The extension is read-only by design: screenshot, console dump, DOM text.
 * Navigation is confined to loopback URLs (same restriction as the design
 * contract's targetUrl), so the bridge cannot be used to drive the user's
 * browser to arbitrary pages.
 */

export const browserRouter = Router();

const COMMAND_KINDS = new Set(["screenshot", "console", "domText"]);
const EXECUTE_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 25_000;
const CONNECTED_WINDOW_MS = 35_000;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 4;

interface BridgeCommand {
  id: string;
  kind: "screenshot" | "console" | "domText";
  url: string;
  selector?: string;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const pending: BridgeCommand[] = [];
const waiters = new Map<string, (result: BridgeResult) => void>();
let pollWaiter: (() => void) | null = null;
let lastPollAt = 0;

function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function bridgeConnected(now = Date.now()): boolean {
  return now - lastPollAt < CONNECTED_WINDOW_MS;
}

/** Test-only: drop queued commands and waiters between cases. */
export function resetBridgeForTests(): void {
  pending.length = 0;
  waiters.clear();
  pollWaiter = null;
  lastPollAt = 0;
}

browserRouter.get("/browser/status", (_req, res) => {
  res.json({ connected: bridgeConnected(), pendingCommands: pending.length });
});

browserRouter.post("/browser/execute", async (req, res) => {
  const { kind, url, selector } = req.body ?? {};
  if (!COMMAND_KINDS.has(kind) || !isLoopbackHttpUrl(url)) {
    return res.status(400).json({ error: "kind must be a bridge command and url loopback http(s)" });
  }
  if (selector !== undefined && (typeof selector !== "string" || selector.length > 512)) {
    return res.status(400).json({ error: "selector is invalid" });
  }
  if (!bridgeConnected()) {
    return res.status(503).json({ error: "the browser extension is not connected" });
  }
  if (pending.length >= MAX_PENDING) {
    return res.status(429).json({ error: "too many queued browser commands" });
  }
  const command: BridgeCommand = {
    id: randomUUID(),
    kind,
    url,
    ...(selector ? { selector } : {}),
  };
  const result = await new Promise<BridgeResult>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(command.id);
      const queued = pending.indexOf(command);
      if (queued !== -1) pending.splice(queued, 1);
      resolve({ ok: false, error: "the browser extension did not answer in time" });
    }, EXECUTE_TIMEOUT_MS);
    waiters.set(command.id, (value) => {
      clearTimeout(timer);
      waiters.delete(command.id);
      resolve(value);
    });
    pending.push(command);
    if (pollWaiter) {
      pollWaiter();
      pollWaiter = null;
    }
  });
  res.status(result.ok ? 200 : 502).json(result);
});

// The extension long-polls here. GET skips the Origin/capability guard, so
// this route re-checks the capability itself — commands carry target URLs
// and no other local process has the token.
browserRouter.get("/browser/poll", async (req, res) => {
  const presented = req.get("X-Glimmer-Capability");
  if (CONFIG.capabilityToken) {
    const expected = Buffer.from(CONFIG.capabilityToken);
    const actual = Buffer.from(presented ?? "");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return res.status(403).json({ error: "capability token required" });
    }
  }
  lastPollAt = Date.now();
  const waitParam = Number(req.query.wait);
  const waitMs = Number.isFinite(waitParam)
    ? Math.max(0, Math.min(POLL_TIMEOUT_MS, waitParam * 1_000))
    : POLL_TIMEOUT_MS;
  if (pending.length === 0 && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      pollWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    pollWaiter = null;
    lastPollAt = Date.now();
  }
  res.json({ commands: pending.splice(0, pending.length) });
});

browserRouter.post("/browser/result", (req, res) => {
  const { id, ok, data, error } = req.body ?? {};
  if (typeof id !== "string" || typeof ok !== "boolean") {
    return res.status(400).json({ error: "result must carry id and ok" });
  }
  if (data !== undefined && JSON.stringify(data).length > MAX_RESULT_BYTES) {
    return res.status(413).json({ error: "browser result is too large" });
  }
  const waiter = waiters.get(id);
  if (!waiter) return res.status(404).json({ error: "no command is waiting for this result" });
  waiter({
    ok,
    ...(data === undefined ? {} : { data }),
    ...(typeof error === "string" ? { error: error.slice(0, 2_000) } : {}),
  });
  res.json({ accepted: true });
});
