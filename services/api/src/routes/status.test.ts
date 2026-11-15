import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { requestLogger } from "../middleware/logger.js";
import * as indexingQueues from "../queues/indexing.js";
import { createStatusRouter } from "./status.js";

describe("Status and Health Routes", () => {
  it("GET /api/status returns 200 and service health summary when services are healthy", async () => {
    const app = express();
    app.use(requestLogger());
    app.use("/api", createStatusRouter());

    // Mock Mongo
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1 as never);
    (mongoose.connection as any).db = {
      admin: () => ({
        ping: vi.fn().mockResolvedValue({ ok: 1 }),
      }),
    };

    // Mock Redis
    const mockRedis = {
      ping: vi.fn().mockResolvedValue("PONG"),
    };
    vi.spyOn(indexingQueues, "getRedisConnection").mockReturnValue(mockRedis as never);

    // Mock Queue
    const mockQueue = {
      getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, failed: 0, completed: 5 }),
    };
    vi.spyOn(indexingQueues, "getIndexingQueue").mockReturnValue(mockQueue as never);

    // Mock fetch for agent healthcheck
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", service: "agent", llm: "available" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await request(app)
      .get("/api/status")
      .set("X-Request-Id", "test-request-id-123");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("test-request-id-123");
    expect(res.body.service).toBe("codescout");
    expect(res.body.services).toBeDefined();
    expect(res.body.services.api.status).toBe("ok");
    expect(res.body.services.agent.status).toBe("ok");
    expect(res.body.services.mongo.status).toBe("ok");
    expect(res.body.services.redis.status).toBe("ok");
    expect(res.body.services.agent.llmProvider).toBe("available");
  });

  it("GET /api/status returns 503 degraded when a dependent service is unreachable", async () => {
    const app = express();
    app.use(requestLogger());
    app.use("/api", createStatusRouter());

    // Mock fetch failure
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Connection refused"));

    const res = await request(app).get("/api/status");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });
});
