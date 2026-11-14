import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import { createApp } from "../app.js";
import { EvalRun } from "../models/evalRun.js";

describe("Evals Router", () => {
  const app = createApp();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/evals returns list of eval runs", async () => {
    const mockRuns = [
      {
        _id: new mongoose.Types.ObjectId().toString(),
        suite: "task",
        createdAt: new Date().toISOString(),
        totalTasks: 15,
        passedTasks: 12,
        metrics: { passRate: 0.8 },
      },
    ];

    vi.spyOn(EvalRun, "find").mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockRuns),
        }),
      }),
    } as any);

    const res = await request(app).get("/api/evals");
    expect(res.status).toBe(200);
    expect(res.body.evalRuns).toHaveLength(1);
    expect(res.body.evalRuns[0].suite).toBe("task");
  });

  it("GET /api/evals/:id returns 400 for invalid ID", async () => {
    const res = await request(app).get("/api/evals/invalid-id");
    expect(res.status).toBe(400);
  });

  it("GET /api/evals/:id returns 404 if not found", async () => {
    const validId = new mongoose.Types.ObjectId().toString();
    vi.spyOn(EvalRun, "findById").mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);

    const res = await request(app).get(`/api/evals/${validId}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/evals/:id returns full eval run details", async () => {
    const validId = new mongoose.Types.ObjectId().toString();
    const mockDoc = {
      _id: validId,
      suite: "task",
      createdAt: new Date().toISOString(),
      totalTasks: 15,
      passedTasks: 15,
      metrics: { passRate: 1.0 },
      results: [{ taskId: "task-01", passed: true }],
    };

    vi.spyOn(EvalRun, "findById").mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockDoc),
    } as any);

    const res = await request(app).get(`/api/evals/${validId}`);
    expect(res.status).toBe(200);
    expect(res.body.evalRun._id).toBe(validId);
    expect(res.body.evalRun.results).toHaveLength(1);
  });
});
