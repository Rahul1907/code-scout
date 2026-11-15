import { Router, type Request, type Response } from "express";
import { getConfig } from "../lib/config.js";
import {
  getGitHubAppInstallUrl,
  getInstallationAccessToken,
  getRepoInstallation,
  isGitHubAppConfigured,
} from "../lib/githubApp.js";
import { type AuthenticatedRequest, requireAuth } from "../middleware/auth.js";
import { AgentRun } from "../models/agentRun.js";
import { Changeset } from "../models/changeset.js";
import { PullRequest } from "../models/pullRequest.js";
import { Repo } from "../models/repo.js";

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

  // GET /api/changesets/:id/pull-request
  router.get("/changesets/:id/pull-request", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");

    try {
      const pr = await PullRequest.findOne({
        $or: [{ changesetId: id }, { runId: id }],
      }).lean();

      if (!pr) {
        res.status(404).json({ error: "Pull request not found for this changeset" });
        return;
      }

      res.status(200).json({ pullRequest: pr });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to fetch pull request",
      });
    }
  });

  // POST /api/changesets/:id/pull-request
  router.post("/changesets/:id/pull-request", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
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

      // Verify repository ownership
      const repo = await Repo.findOne({ _id: changeset.repoId, userId: auth.sub });
      if (!repo) {
        res.status(403).json({ error: "Only the repository owner can open pull requests" });
        return;
      }

      // Check if PR already exists
      const existingPr = await PullRequest.findOne({ changesetId: changeset._id }).lean();
      if (existingPr) {
        res.status(200).json({
          pullRequest: existingPr,
          message: "Pull request already opened for this changeset",
        });
        return;
      }

      // Check if GitHub App is installed, or auto-detect from GitHub API
      let installationId = repo.githubInstallationId;
      if (!installationId || installationId <= 0) {
        const detectedId = await getRepoInstallation(repo.fullName, config);
        if (detectedId) {
          installationId = detectedId;
          await Repo.updateOne({ _id: repo._id }, { $set: { githubInstallationId: detectedId } });
        }
      }

      if (!installationId || installationId <= 0) {
        const installUrl = getGitHubAppInstallUrl(repo._id.toString());
        res.status(400).json({
          error: "GitHub App is not installed on this repository. Please install it first to enable PR creation.",
          installUrl,
        });
        return;
      }

      // 1. Generate PR title & body from Agent service
      let prTitle = `fix: automated improvements for run ${changeset.runId.slice(0, 8)}`;
      let prBody = `## Summary\nAutomated pull request from CodeScout agent run ${changeset.runId}.\n`;

      try {
        const genRes = await fetch(`${config.AGENT_URL}/internal/runs/${changeset.runId}/generate-pr`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            repoId: repo._id.toString(),
            instruction: "Create PR for completed code edits",
          }),
        });
        if (genRes.ok) {
          const genData = (await genRes.json()) as { title?: string; body?: string };
          if (genData.title) prTitle = genData.title;
          if (genData.body) prBody = genData.body;
        }
      } catch (genErr) {
        console.warn("Failed to generate PR content from agent service, using default:", genErr);
      }

      // 2. Obtain GitHub App installation access token
      let token = "mock-dev-token";
      const isConfigured = isGitHubAppConfigured(config);
      if (isConfigured) {
        const tokenRes = await getInstallationAccessToken(installationId, config);
        token = tokenRes.token;
      }

      const branchName = `agent/${changeset.runId}`;
      const remoteUrl = `https://x-access-token:${token}@github.com/${repo.fullName}.git`;

      // 3. Commit and push branch from agent worktree
      try {
        const pushRes = await fetch(`${config.AGENT_URL}/internal/runs/${changeset.runId}/commit-and-push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            repoId: repo._id.toString(),
            commitMessage: prTitle,
            remoteUrl: isConfigured ? remoteUrl : undefined,
            branchName,
          }),
        });

        if (!pushRes.ok) {
          const errText = await pushRes.text();
          console.warn("Agent commit-and-push warning:", errText);
        }
      } catch (pushErr) {
        console.warn("Failed to invoke agent commit-and-push:", pushErr);
      }

      // 4. Create Pull Request on GitHub
      let prNumber = Math.floor(Math.random() * 900) + 100;
      let prUrl = `https://github.com/${repo.fullName}/pull/${prNumber}`;

      if (isConfigured) {
        const githubPrRes = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`,
          {
            method: "POST",
            headers: {
              Authorization: `token ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "CodeScout-Agent",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title: prTitle,
              body: prBody,
              head: branchName,
              base: repo.defaultBranch || "main",
            }),
          }
        );

        if (!githubPrRes.ok) {
          const ghErr = await githubPrRes.text();
          throw new Error(`GitHub API failed to create pull request (${githubPrRes.status}): ${ghErr}`);
        }

        const ghData = (await githubPrRes.json()) as { number: number; html_url: string };
        prNumber = ghData.number;
        prUrl = ghData.html_url;
      }

      // 5. Save PullRequest record
      const pullRequest = await PullRequest.create({
        repoId: repo._id,
        runId: changeset.runId,
        changesetId: changeset._id,
        userId: auth.sub,
        prNumber,
        prUrl,
        title: prTitle,
        body: prBody,
        headBranch: branchName,
        baseBranch: repo.defaultBranch || "main",
        status: "open",
      });

      // 6. Update changeset status and PR details
      changeset.status = "approved";
      changeset.pullRequest = {
        prNumber,
        prUrl,
        title: prTitle,
      };
      await changeset.save();

      // Mark agent run as completed
      await AgentRun.updateOne(
        { runId: changeset.runId },
        { $set: { status: "completed" } }
      );

      res.status(201).json({ pullRequest, changeset });
    } catch (err) {
      console.error("Error creating pull request:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to create pull request",
      });
    }
  });

  return router;
}

