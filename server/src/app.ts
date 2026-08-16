import express, { type Express } from "express";
import cors from "cors";
import { statusRouter } from "./routes/status";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", statusRouter);
  return app;
}
