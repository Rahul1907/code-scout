import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface RequestWithId extends Request {
  id?: string;
}

export function requestLogger() {
  return (req: RequestWithId, res: Response, next: NextFunction): void => {
    const rawId = req.headers["x-request-id"];
    const requestId = typeof rawId === "string" && rawId.trim().length > 0 ? rawId : crypto.randomUUID();
    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startTime = Date.now();

    res.on("finish", () => {
      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;
      const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

      // Do not flood stdout with frequent healthcheck pings
      if (req.url === "/api/health" && statusCode === 200) {
        return;
      }

      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          service: "api",
          requestId,
          method: req.method,
          url: req.originalUrl || req.url,
          statusCode,
          durationMs,
        }),
      );
    });

    next();
  };
}

