import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { getGitHubRepo, listUserGitHubRepos } from "../github/client.js";
import { getConfig } from "../lib/config.js";
import { decryptToken } from "../lib/crypto.js";
import { type AuthenticatedRequest, requireAuth } from "../middleware/auth.js";
import { Chunk } from "../models/chunk.js";
import { Repo } from "../models/repo.js";
import { User } from "../models/user.js";
import { enqueueIndexingJob } from "../queues/indexing.js";

const REPOS_ROOT = "/data/repos";

const connectRepoSchema = z.object({
  fullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "fullName must be in owner/name format"),
});

const listGitHubReposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().optional(),
});

const fileQuerySchema = z.object({
  path: z.string().min(1),
  start: z.coerce.number().int().min(1).optional(),
  end: z.coerce.number().int().min(1).optional(),
});

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

const IGNORED_TREE_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__"]);

async function buildFileTree(rootDir: string, currentRel = ""): Promise<TreeNode[]> {
  const fullDir = currentRel ? path.join(rootDir, currentRel) : rootDir;
  let entries;
  try {
    entries = await fs.readdir(fullDir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_TREE_DIRS.has(entry.name)) {
      continue;
    }
    const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "dir",
        children: await buildFileTree(rootDir, relPath),
      });
    } else if (entry.isFile()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "file",
      });
    }
  }
  return nodes;
}

function resolveSafeRepoFile(repoId: string, requestedPath: string): string | null {
  const baseDir = path.resolve(REPOS_ROOT, repoId, "base");
  const normalized = requestedPath.replace(/^\/+/, "");
  const resolved = path.resolve(baseDir, normalized);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    return null;
  }
  return resolved;
}

async function getUserGitHubToken(userId: string): Promise<string | null> {
  const config = getConfig();
  const user = await User.findById(userId).lean();
  if (!user) return null;
  return decryptToken(user.accessTokenEncrypted, config.TOKEN_ENCRYPTION_KEY);
}

export function createReposRouter(): Router {
  const router = Router();
  router.use("/repos", requireAuth);
  router.use("/github/repos", requireAuth);

  router.get("/github/repos", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const parsed = listGitHubReposQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
      return;
    }

    const token = await getUserGitHubToken(auth.sub);
    if (!token) {
      res.status(401).json({ error: "User session invalid" });
      return;
    }

    try {
      const { page, per_page: perPage, q } = parsed.data;
      const result = await listUserGitHubRepos(token, page, perPage);
      const filtered = q
        ? result.repos.filter(
            (r) =>
              r.fullName.toLowerCase().includes(q.toLowerCase()) ||
              r.description.toLowerCase().includes(q.toLowerCase()),
          )
        : result.repos;

      res.status(200).json({
        repos: filtered,
        page,
        perPage,
        hasMore: result.hasMore,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "GitHub API failure" });
    }
  });

  router.post("/repos", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const config = getConfig();
    const parsed = connectRepoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
      return;
    }

    const token = await getUserGitHubToken(auth.sub);
    if (!token) {
      res.status(401).json({ error: "User session invalid" });
      return;
    }

    try {
      const ghRepo = await getGitHubRepo(parsed.data.fullName, token);
      if (!ghRepo) {
        res.status(404).json({ error: `Repository ${parsed.data.fullName} not found on GitHub` });
        return;
      }

      if (ghRepo.private) {
        res.status(400).json({ error: "Only public repositories are supported" });
        return;
      }

      const maxSizeKb = config.MAX_REPO_SIZE_MB * 1024;
      if (ghRepo.sizeKb > maxSizeKb) {
        res.status(400).json({
          error: `Repository exceeds ${config.MAX_REPO_SIZE_MB} MB limit (${Math.round(ghRepo.sizeKb / 1024)} MB)`,
        });
        return;
      }

      const existing = await Repo.findOne({ userId: auth.sub, fullName: ghRepo.fullName }).lean();
      if (existing) {
        res.status(409).json({
          error: "Repository is already connected",
          repo: existing,
        });
        return;
      }

      const repo = await Repo.create({
        userId: auth.sub,
        owner: ghRepo.owner,
        name: ghRepo.name,
        fullName: ghRepo.fullName,
        defaultBranch: ghRepo.defaultBranch,
        status: "pending",
        progress: { stage: "queued", processedFiles: 0, totalFiles: 0 },
      });

      const jobId = await enqueueIndexingJob({
        repoId: repo._id.toString(),
        cloneUrl: `https://github.com/${ghRepo.fullName}.git`,
        defaultBranch: ghRepo.defaultBranch,
        userId: auth.sub,
      });

      res.status(201).json({ repo, jobId });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Failed to connect repository" });
    }
  });

  router.get("/repos", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const repos = await Repo.find({ userId: auth.sub }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ repos });
  });

  router.get("/repos/:id", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const repo = await Repo.findOne({ _id: id, userId: auth.sub }).lean();
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    res.status(200).json({ repo });
  });

  router.post("/repos/:id/reindex", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const repo = await Repo.findOneAndUpdate(
      { _id: id, userId: auth.sub },
      {
        $set: {
          status: "pending",
          error: "",
          progress: { stage: "queued", processedFiles: 0, totalFiles: 0 },
        },
      },
      { new: true },
    );

    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const jobId = await enqueueIndexingJob({
      repoId: repo._id.toString(),
      cloneUrl: `https://github.com/${repo.fullName}.git`,
      defaultBranch: repo.defaultBranch,
      userId: auth.sub,
    });

    res.status(202).json({ repo, jobId });
  });

  router.delete("/repos/:id", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const repo = await Repo.findOneAndDelete({ _id: id, userId: auth.sub });
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    await Chunk.deleteMany({ repoId: id });
    await fs.rm(path.join(REPOS_ROOT, id), { recursive: true, force: true });

    res.status(200).json({ ok: true });
  });

  router.get("/repos/:id/tree", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const repo = await Repo.findOne({ _id: id, userId: auth.sub }).lean();
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const baseDir = path.join(REPOS_ROOT, id, "base");
    const tree = await buildFileTree(baseDir);
    res.status(200).json({ tree });
  });

  router.get("/repos/:id/file", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const parsed = fileQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid file query" });
      return;
    }

    const repo = await Repo.findOne({ _id: id, userId: auth.sub }).lean();
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const resolved = resolveSafeRepoFile(id, parsed.data.path);
    if (!resolved) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }

    try {
      const content = await fs.readFile(resolved, "utf8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const startLine = parsed.data.start ?? 1;
      const endLine = parsed.data.end ?? totalLines;
      const sliced = lines.slice(startLine - 1, endLine).join("\n");

      res.status(200).json({
        path: parsed.data.path,
        startLine,
        endLine: Math.min(endLine, totalLines),
        totalLines,
        content: sliced,
      });
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  return router;
}

