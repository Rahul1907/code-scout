import { Router, type Request, type Response } from "express";
import { getConfig } from "../lib/config.js";
import { type AuthenticatedRequest, requireAuth } from "../middleware/auth.js";
import { AgentRun } from "../models/agentRun.js";

export function createRunsRouter(): Router {
  const router = Router();
  router.use("/runs", requireAuth);

  router.post("/runs/:id/cancel", async (req: Request, res: Response) => {
    const runId = String(req.params.id ?? "");
    const config = getConfig();

    try {
      const agentRes = await fetch(`${config.AGENT_URL}/internal/runs/${runId}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.INTERNAL_API_KEY,
        },
      });

      if (!agentRes.ok) {
        const text = await agentRes.text();
        res.status(agentRes.status).json({ error: `Agent cancellation failed: ${text}` });
        return;
      }

      await AgentRun.updateOne({ runId }, { $set: { status: "cancelled" } });
      res.status(200).json({ status: "cancelled", runId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Cancellation failed" });
    }
  });

  router.get("/runs/:id", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const runId = String(req.params.id ?? "");

    try {
      const run = await AgentRun.findOne({
        runId,
        $or: [{ userId: auth.sub }, { userId: undefined }],
      }).lean();

      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      res.status(200).json({ run });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch run" });
    }
  });

  return router;
}

