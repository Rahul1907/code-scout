import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";

export function createApp(): Express {
  const app = express();

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  app.use(helmet());
  app.use(
    cors({
      origin: appUrl,
      credentials: true,
    }),
  );
  app.use(express.json());

  app.get("/api/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

