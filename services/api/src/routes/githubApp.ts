import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import { getConfig } from "../lib/config.js";
import {
  getGitHubAppInstallUrl,
  getInstallationAccessToken,
  getRepoInstallation,
  isGitHubAppConfigured,
  verifyWebhookSignature,
} from "../lib/githubApp.js";
import { type AuthenticatedRequest, requireAuth } from "../middleware/auth.js";
import { Repo } from "../models/repo.js";

export function createGitHubAppRouter(): Router {
  const router = Router();

  // Public: check if GitHub App is configured
  router.get("/github/app/status", (_req: Request, res: Response) => {
    const config = getConfig();
    res.status(200).json({
      configured: isGitHubAppConfigured(config),
      slug: config.GITHUB_APP_SLUG || "codescout-agent",
    });
  });

  // Public/Auth: get installation URL with optional state
  router.get("/github/app/install-url", (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const url = getGitHubAppInstallUrl(state);
    res.status(200).json({ url });
  });

  // GitHub App installation callback
  // GitHub redirects here after the user installs the App
  router.get("/github/app/callback", async (req: Request, res: Response) => {
    const config = getConfig();
    const rawInstallationId = req.query.installation_id;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;

    if (rawInstallationId) {
      const installationId = Number(rawInstallationId);
      if (!Number.isNaN(installationId)) {
        if (state && mongoose.isValidObjectId(state)) {
          try {
            await Repo.updateOne(
              { _id: state },
              { $set: { githubInstallationId: installationId } },
            );
          } catch (err) {
            console.error("Failed to associate GitHub installation with repo:", err);
          }
        } else {
          try {
            const tokenRes = await getInstallationAccessToken(installationId, config);
            const reposRes = await fetch("https://api.github.com/installation/repositories", {
              headers: {
                Authorization: `Bearer ${tokenRes.token}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "CodeScout-Agent",
              },
            });
            if (reposRes.ok) {
              const reposData = (await reposRes.json()) as { repositories: Array<{ full_name: string }> };
              const fullNames = reposData.repositories.map((r) => r.full_name);
              await Repo.updateMany(
                { fullName: { $in: fullNames } },
                { $set: { githubInstallationId: installationId } },
              );
            }
          } catch (e) {
            console.error("Failed to auto-link installation repositories:", e);
          }
        }
      }
    }

    const redirectPath = state && mongoose.isValidObjectId(state) ? `/repos/${state}` : "/dashboard";
    res.redirect(`${config.APP_URL}${redirectPath}?github_installed=true`);
  });

  // Authenticated: Get repo GitHub App installation status
  router.get("/repos/:id/github", requireAuth, async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const repoId = String(req.params.id ?? "");
    const config = getConfig();

    if (!mongoose.isValidObjectId(repoId)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    try {
      const repo = await Repo.findOne({ _id: repoId, userId: auth.sub }).lean();
      if (!repo) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }

      let installationId = repo.githubInstallationId;
      if (!installationId || installationId <= 0) {
        const detectedId = await getRepoInstallation(repo.fullName, config);
        if (detectedId) {
          installationId = detectedId;
          await Repo.updateOne({ _id: repoId }, { $set: { githubInstallationId: detectedId } });
        }
      }

      const installed = typeof installationId === "number" && installationId > 0;
      const installUrl = getGitHubAppInstallUrl(repoId);

      res.status(200).json({
        installed,
        installationId: installationId ?? null,
        installUrl,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to get GitHub status",
      });
    }
  });

  // Authenticated: Explicitly link installation ID to repo
  router.post("/repos/:id/github/link", requireAuth, async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const repoId = String(req.params.id ?? "");
    const installationId = Number(req.body.installationId);

    if (!mongoose.isValidObjectId(repoId)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }
    if (Number.isNaN(installationId) || installationId <= 0) {
      res.status(400).json({ error: "Valid positive installationId required" });
      return;
    }

    try {
      const repo = await Repo.findOneAndUpdate(
        { _id: repoId, userId: auth.sub },
        { $set: { githubInstallationId: installationId } },
        { new: true },
      ).lean();

      if (!repo) {
        res.status(404).json({ error: "Repository not found" });
        return;
      }

      res.status(200).json({
        ok: true,
        installed: true,
        installationId: repo.githubInstallationId,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to link installation ID",
      });
    }
  });

  // Webhook for GitHub App events
  router.post("/github/webhook", async (req: Request, res: Response) => {
    const config = getConfig();
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (config.GITHUB_APP_WEBHOOK_SECRET) {
      const rawBody = JSON.stringify(req.body);
      if (!verifyWebhookSignature(rawBody, signature, config.GITHUB_APP_WEBHOOK_SECRET)) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const event = req.headers["x-github-event"] as string | undefined;
    const payload = req.body as Record<string, any>;

    try {
      if (event === "installation" || event === "installation_repositories") {
        const action = payload.action;
        const installationId = payload.installation?.id;

        if (action === "deleted" && installationId) {
          await Repo.updateMany(
            { githubInstallationId: installationId },
            { $set: { githubInstallationId: null } },
          );
        } else if (
          (action === "created" || action === "added") &&
          installationId &&
          Array.isArray(payload.repositories)
        ) {
          for (const r of payload.repositories) {
            if (r.full_name) {
              await Repo.updateMany(
                { fullName: r.full_name },
                { $set: { githubInstallationId: installationId } },
              );
            }
          }
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error("Error processing GitHub webhook:", err);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  return router;
}

