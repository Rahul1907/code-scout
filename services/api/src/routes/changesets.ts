import { Router, type Request, type Response } from "express";
import { getConfig } from "../lib/config.js";
import { requireAuth } from "../middleware/auth.js";
import { AgentRun } from "../models/agentRun.js";
import { Changeset } from "../models/changeset.js";

export function createChangesetsRouter(): Router {
  const router = Router();
  router.use("/runs", requireAuth);
  router.use("/changesets", requireAuth);

  // GET /api/runs/:id/changeset
  router.get("/runs/:id/changeset", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");

    try {
      const changeset = await Changeset.findOne({
        $or: [{ runId: id }, { _id: id }],
      }).lean();
      if (!changeset) {
        res.status(404).json({ error: "Changeset not found for this run" });
        return;
      }

      res.status(200).json({ changeset });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to fetch changeset",
      });
    }
  });

  // POST /api/changesets/:id/approve
  router.post("/changesets/:id/approve", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");

    try {
      const changeset =
        (await Changeset.findById(id)) ??
        (await Changeset.findOne({ $or: [{ _id: id }, { runId: id }] }));
      if (!changeset) {
        res.status(404).json({ error: "Changeset not found" });
        return;
      }

      changeset.status = "approved";
      await changeset.save();

      // Mark corresponding agent run as completed
      await AgentRun.updateOne(
        { runId: changeset.runId },
        { $set: { status: "completed" } }
      );

      res.status(200).json({ changeset });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to approve changeset",
      });
    }
  });

  // POST /api/changesets/:id/reject
  router.post("/changesets/:id/reject", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const config = getConfig();

    try {
      const changeset =
        (await Changeset.findById(id)) ??
        (await Changeset.findOne({ $or: [{ _id: id }, { runId: id }] }));
      if (!changeset) {
        res.status(404).json({ error: "Changeset not found" });
        return;
      }

      changeset.status = "rejected";
      await changeset.save();

      // Discard worktree and container in agent service
      try {
        await fetch(`${config.AGENT_URL}/internal/runs/${changeset.runId}/discard`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_API_KEY,
          },
          body: JSON.stringify({ repoId: changeset.repoId }),
        });
      } catch (agentErr) {
        // Log agent error but proceed with rejection
        console.warn("Failed to notify agent service to discard worktree:", agentErr);
      }

      // Mark corresponding agent run as cancelled
      await AgentRun.updateOne(
        { runId: changeset.runId },
        { $set: { status: "cancelled" } }
      );

      res.status(200).json({ changeset });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to reject changeset",
      });
    }
  });

  return router;
}

