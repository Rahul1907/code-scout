import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import { getConfig } from "./lib/config.js";
import { createAuthRouter } from "./routes/auth.js";

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

  return app;
}
