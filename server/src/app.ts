import express, { type Express } from "express";
import cors from "cors";
import { statusRouter } from "./routes/status";
import { sessionsRouter } from "./routes/sessions";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", statusRouter);
  app.use("/api", sessionsRouter);
  return app;
}
