import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import { getConfig } from "../lib/config.js";
import { getIndexingQueue, getRedisConnection } from "../queues/indexing.js";

export function createStatusRouter(): Router {
  const router = Router();

  router.get("/status", async (req: Request, res: Response) => {
    const config = getConfig();
    const requestId = (req as { id?: string }).id ?? "unknown";

    const services: Record<string, unknown> = {
      api: {
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };

    let overallOk = true;

    // 1. Check MongoDB
    try {
      const dbState = mongoose.connection.readyState;
      if (dbState === 1 && mongoose.connection.db) {
        const start = Date.now();
        await mongoose.connection.db.admin().ping();
        services.mongo = {
          status: "ok",
          latencyMs: Date.now() - start,
        };
      } else {
        services.mongo = {
          status: dbState === 2 ? "connecting" : "disconnected",
        };
        overallOk = false;
      }
    } catch (err) {
      services.mongo = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      overallOk = false;
    }

    // 2. Check Redis
    try {
      const redis = getRedisConnection();
      const start = Date.now();
      const pong = await redis.ping();
      services.redis = {
        status: pong === "PONG" ? "ok" : "degraded",
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      services.redis = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      overallOk = false;
    }

    // 3. Check BullMQ Indexing Queue
    try {
      const queue = getIndexingQueue();
      const jobCounts = await queue.getJobCounts("active", "waiting", "failed", "completed");
      services.queue = {
        status: "ok",
        counts: jobCounts,
      };
    } catch (err) {
      services.queue = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. Check Agent Service & LLM Provider Availability
    try {
      const start = Date.now();
      const agentRes = await fetch(`${config.AGENT_URL}/internal/health`, {
        headers: { "X-Request-Id": requestId },
        signal: AbortSignal.timeout(4000),
      });

      if (agentRes.ok) {
        const agentData = (await agentRes.json()) as { status: string; llm?: string };
        services.agent = {
          status: agentData.status,
          latencyMs: Date.now() - start,
          llmProvider: agentData.llm || "available",
        };
      } else {
        services.agent = {
          status: "degraded",
          statusCode: agentRes.status,
        };
        overallOk = false;
      }
    } catch (err) {
      services.agent = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      overallOk = false;
    }

    const statusCode = overallOk ? 200 : 503;
    res.status(statusCode).json({
      status: overallOk ? "ok" : "degraded",
      service: "codescout",
      timestamp: new Date().toISOString(),
      services,
    });
  });

  return router;
}

