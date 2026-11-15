import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { Repo } from "../models/repo.js";

export interface CleanupResult {
  worktreesDeleted: number;
  reposCleaned: number;
  errors: string[];
  durationMs: number;
}

export async function runCleanup(options?: {
  reposBaseDir?: string;
  maxWorktreeAgeHours?: number;
  maxInactiveDays?: number;
}): Promise<CleanupResult> {
  const startedAt = Date.now();
  const reposBaseDir = options?.reposBaseDir ?? "/data/repos";
  const maxWorktreeAgeMs = (options?.maxWorktreeAgeHours ?? 24) * 60 * 60 * 1000;
  const maxInactiveMs = (options?.maxInactiveDays ?? 14) * 24 * 60 * 60 * 1000;

  let worktreesDeleted = 0;
  let reposCleaned = 0;
  const errors: string[] = [];

  const now = Date.now();

  // 1. Delete worktrees older than 24 hours
  try {
    if (fs.existsSync(reposBaseDir)) {
      const repoDirs = fs.readdirSync(reposBaseDir, { withFileTypes: true });

      for (const repoDir of repoDirs) {
        if (!repoDir.isDirectory()) continue;
        const runsDir = path.join(reposBaseDir, repoDir.name, "runs");
        if (!fs.existsSync(runsDir)) continue;

        const runDirs = fs.readdirSync(runsDir, { withFileTypes: true });
        for (const runDir of runDirs) {
          if (!runDir.isDirectory()) continue;
          const fullRunPath = path.join(runsDir, runDir.name);
          try {
            const stats = fs.statSync(fullRunPath);
            const ageMs = now - stats.mtimeMs;
            if (ageMs > maxWorktreeAgeMs) {
              fs.rmSync(fullRunPath, { recursive: true, force: true });
              worktreesDeleted += 1;
            }
          } catch (e) {
            errors.push(`Failed to check or remove worktree ${fullRunPath}: ${e}`);
          }
        }
      }
    }
  } catch (err) {
    errors.push(`Error during worktree cleanup: ${err}`);
  }

  // 2. Clean base directories for repositories inactive for > 14 days
  try {
    if (mongoose.connection.readyState === 1) {
      const inactiveThreshold = new Date(now - maxInactiveMs);
      const staleRepos = await Repo.find({
        updatedAt: { $lt: inactiveThreshold },
      }).lean();

      for (const repo of staleRepos) {
        const repoPath = path.join(reposBaseDir, repo._id.toString());
        if (fs.existsSync(repoPath)) {
          try {
            fs.rmSync(repoPath, { recursive: true, force: true });
            await Repo.updateOne(
              { _id: repo._id },
              { $set: { status: "pending", commitSha: undefined } },
            );
            reposCleaned += 1;
          } catch (e) {
            errors.push(`Failed to clean inactive repo ${repo._id}: ${e}`);
          }
        }
      }
    }
  } catch (err) {
    errors.push(`Error during inactive repo cleanup: ${err}`);
  }

  const durationMs = Date.now() - startedAt;

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      service: "worker",
      task: "cleanup",
      worktreesDeleted,
      reposCleaned,
      durationMs,
      errorCount: errors.length,
    }),
  );

  return {
    worktreesDeleted,
    reposCleaned,
    errors,
    durationMs,
  };
}

