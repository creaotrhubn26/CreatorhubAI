import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { statusRouter } from "./routes/status.js";
import { sessionsRouter } from "./routes/sessions.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { modelRouter } from "./routes/model.js";
import { repositoryRouter } from "./routes/repository.js";
import { taskIntelligenceRouter } from "./routes/taskIntelligence.js";
import { integrationsRouter } from "./routes/integrations.js";

// The only origins allowed to reach this API: the local web dev server
// (web/vite.config.ts port 5183, either loopback spelling) and the packaged
// Tauri desktop shell's webview. `tauri://localhost` is not a guess — it is
// what the installed app actually puts on the wire (captured live from the
// notarized bundle in /Applications, along with `Host: 127.0.0.1:4317`).
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5183",
  "http://localhost:5183",
  "tauri://localhost",
  "https://tauri.localhost",
]);

// Loopback spellings only. Anything else in the Host header means the request
// arrived through a name that resolves here — i.e. DNS rebinding, which would
// otherwise make an attacker's page same-origin with this API and let it read
// every response.
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Methods that don't change state. Everything else must prove where it came from.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/// CSRF + DNS-rebinding guard for the whole gateway, not just one router.
///
/// CORS is not a defence here: an allowlist only withholds
/// `Access-Control-Allow-Origin` so a foreign page can't *read* the response —
/// the handler still runs. Every state-changing route on this API has side
/// effects on the user's machine (spawn/kill the model server, run
/// glimmer-v2.py, write to a repo worktree), so a cross-origin POST that
/// merely executes is already the whole attack. Verified: a plain
/// `POST /api/model/start` with `Content-Type: text/plain` and a foreign
/// Origin — a simple request, no preflight consulted — spawned a real process.
///
/// Policy, deliberately strict about a missing Origin: every browser sends
/// `Origin` on cross-origin state-changing requests, including form posts
/// (that is exactly the `text/plain` form-shaped attack above, and it carries
/// an Origin). So a POST with no Origin is not a browser page we trust — it's
/// a non-browser client, and this API is not a public one. Rejecting it costs
/// a curl user one `-H "Origin: ..."` and closes the hole rather than leaving
/// a header-omission bypass open.
export function localOnlyGuard(req: Request, res: Response, next: NextFunction) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return res.status(403).json({
      error: `request rejected: unexpected Host "${req.headers.host ?? ""}" (loopback only)`,
    });
  }
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({
      error: origin
        ? `request rejected: origin "${origin}" may not make state-changing requests`
        : "request rejected: state-changing requests must carry an allowed Origin header",
    });
  }
  next();
}

export function createApp(): Express {
  const app = express();
  // Ahead of everything, including the routers: the guard is the trust
  // boundary for every write route on this API, current and future.
  app.use(localOnlyGuard);
  // CORS still matters for the read path (it decides what the webview is
  // allowed to *read*); the guard above decides what may *execute*.
  app.use(cors({ origin: [...ALLOWED_ORIGINS] }));
  app.use(express.json());
  app.use("/api", statusRouter);
  app.use("/api", sessionsRouter);
  app.use("/api", workspacesRouter);
  app.use("/api", modelRouter);
  app.use("/api", repositoryRouter);
  app.use("/api", taskIntelligenceRouter);
  app.use("/api", integrationsRouter);
  // Terminal error handler: Express 4 does not catch async handler rejections,
  // and an unhandled rejection kills the gateway (orphaning running agents).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[gateway] unhandled route error:", err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
