import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { statusRouter } from "./routes/status.js";
import { sessionsRouter } from "./routes/sessions.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { modelRouter } from "./routes/model.js";
import { repositoryRouter } from "./routes/repository.js";
import { taskIntelligenceRouter } from "./routes/taskIntelligence.js";

export function createApp(): Express {
  const app = express();
  // This API spawns processes and writes to the repo: only the local web dev
  // server's origin (web/vite.config.ts port 5183, either loopback spelling)
  // or the packaged Tauri desktop shell's webview origin may call it — never
  // `*`, which any visited website could reach.
  app.use(
    cors({
      origin: [
        "http://127.0.0.1:5183",
        "http://localhost:5183",
        "tauri://localhost",
        "https://tauri.localhost",
      ],
    })
  );
  app.use(express.json());
  app.use("/api", statusRouter);
  app.use("/api", sessionsRouter);
  app.use("/api", workspacesRouter);
  app.use("/api", modelRouter);
  app.use("/api", repositoryRouter);
  app.use("/api", taskIntelligenceRouter);
  // Terminal error handler: Express 4 does not catch async handler rejections,
  // and an unhandled rejection kills the gateway (orphaning running agents).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[gateway] unhandled route error:", err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
