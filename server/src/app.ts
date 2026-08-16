import express, { type Express } from "express";
import cors from "cors";
import { statusRouter } from "./routes/status";
import { sessionsRouter } from "./routes/sessions";
import { workspacesRouter } from "./routes/workspaces";
import { modelRouter } from "./routes/model";
import { repositoryRouter } from "./routes/repository";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", statusRouter);
  app.use("/api", sessionsRouter);
  app.use("/api", workspacesRouter);
  app.use("/api", modelRouter);
  app.use("/api", repositoryRouter);
  return app;
}
