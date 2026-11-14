import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import { EvalRun } from "../models/evalRun.js";

export function createEvalsRouter(): Router {
  const router = Router();

  // GET /api/evals
  router.get("/evals", async (req: Request, res: Response) => {
    try {
      const suite = req.query.suite as string | undefined;
      const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 100);
      const query: Record<string, any> = {};
      if (suite && ["retrieval", "task"].includes(suite)) {
        query.suite = suite;
      }

      // Exclude heavy results array in list view for fast response
      const evalRuns = await EvalRun.find(query, {
        results: 0,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      res.json({ evalRuns });
    } catch (err: any) {
      console.error("Failed to list eval runs:", err);
      res.status(500).json({ error: "Failed to list eval runs" });
    }
  });

  // GET /api/evals/:id
  router.get("/evals/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ error: "Invalid eval run ID" });
        return;
      }

      const evalRun = await EvalRun.findById(id).lean();
      if (!evalRun) {
        res.status(404).json({ error: "Eval run not found" });
        return;
      }

      res.json({ evalRun });
    } catch (err: any) {
      console.error("Failed to get eval run:", err);
      res.status(500).json({ error: "Failed to get eval run" });
    }
  });

  return router;
}
