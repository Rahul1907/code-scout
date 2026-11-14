import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import { getConfig } from "./lib/config.js";
import { createAuthRouter } from "./routes/auth.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createReposRouter } from "./routes/repos.js";
import { createRunsRouter } from "./routes/runs.js";
import { createChangesetsRouter } from "./routes/changesets.js";
import { createGitHubAppRouter } from "./routes/githubApp.js";

export function createApp(): Express {
  const app = express();
  const config = getConfig();

  app.use(helmet());
  app.use(
    cors({
      origin: config.APP_URL,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json());

  app.get("/api/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api", createAuthRouter());
  app.use("/api", createReposRouter());
  app.use("/api", createConversationsRouter());
  app.use("/api", createRunsRouter());
  app.use("/api", createChangesetsRouter());
  app.use("/api", createGitHubAppRouter());

  return app;
}
