import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { getConfig } from "../lib/config.js";
import { type AuthenticatedRequest, requireAuth } from "../middleware/auth.js";
import { Conversation } from "../models/conversation.js";
import { Message } from "../models/message.js";
import { Repo } from "../models/repo.js";

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});

const postMessageSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  mode: z.enum(["ask", "edit"]).default("ask"),
});

interface CitationPayload {
  filePath: string;
  startLine: number;
  endLine: number;
}

interface RetrievedChunkPayload {
  chunkId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  source: "vector" | "keyword" | "both" | "unknown";
  symbolName?: string;
  content?: string;
}

export function createConversationsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post("/repos/:id/conversations", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const repoId = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(repoId)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const parsed = createConversationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
      return;
    }

    const repo = await Repo.findOne({ _id: repoId, userId: auth.sub }).lean();
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const conversation = await Conversation.create({
      userId: auth.sub,
      repoId,
      title: parsed.data.title ?? "New conversation",
    });

    res.status(201).json({ conversation });
  });

  router.get("/repos/:id/conversations", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const repoId = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(repoId)) {
      res.status(400).json({ error: "Invalid repository id" });
      return;
    }

    const repo = await Repo.findOne({ _id: repoId, userId: auth.sub }).lean();
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const conversations = await Conversation.find({ userId: auth.sub, repoId })
      .sort({ updatedAt: -1 })
      .lean();
    res.status(200).json({ conversations });
  });

  router.get("/conversations/:id/messages", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const convId = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const conversation = await Conversation.findOne({ _id: convId, userId: auth.sub }).lean();
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const messages = await Message.find({ conversationId: convId }).sort({ createdAt: 1 }).lean();
    res.status(200).json({ messages });
  });

  router.post("/conversations/:id/messages", async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const config = getConfig();
    const convId = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const parsed = postMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid message payload" });
      return;
    }

    const conversation = await Conversation.findOne({ _id: convId, userId: auth.sub });
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const repo = await Repo.findOne({ _id: conversation.repoId, userId: auth.sub }).lean();
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (repo.status !== "ready") {
      res.status(409).json({ error: `Repository is not ready yet (status: ${repo.status})` });
      return;
    }

    const priorMessages = await Message.find({ conversationId: convId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    const history = priorMessages
      .reverse()
      .map((m) => ({ role: m.role, content: m.content }));

    await Message.create({
      conversationId: convId,
      role: "user",
      content: parsed.data.content,
    });

    if (conversation.title === "New conversation") {
      conversation.title = parsed.data.content.slice(0, 60);
      await conversation.save();
    }

    const runId = crypto.randomUUID();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let assistantText = "";
    const citations: CitationPayload[] = [];
    const seenCitations = new Set<string>();
    const retrievedChunks: RetrievedChunkPayload[] = [];

    const parseSseBlock = (block: string): void => {
      let eventType = "";
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (!eventType || dataLines.length === 0) return;
      try {
        const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        if (eventType === "token" && typeof data.text === "string") {
          assistantText += data.text;
        } else if (
          eventType === "citation" &&
          typeof data.filePath === "string" &&
          typeof data.startLine === "number" &&
          typeof data.endLine === "number"
        ) {
          const key = `${data.filePath}:${data.startLine}-${data.endLine}`;
          if (!seenCitations.has(key)) {
            seenCitations.add(key);
            citations.push({
              filePath: data.filePath,
              startLine: data.startLine,
              endLine: data.endLine,
            });
          }
        } else if (eventType === "retrieval_debug" && Array.isArray(data.chunks)) {
          for (const item of data.chunks) {
            if (
              item &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).filePath === "string" &&
              typeof (item as Record<string, unknown>).startLine === "number" &&
              typeof (item as Record<string, unknown>).endLine === "number"
            ) {
              const obj = item as Record<string, unknown>;
              const rawSource = String(obj.source ?? "unknown");
              const validSources = ["vector", "keyword", "both", "unknown"];
              const source = (validSources.includes(rawSource)
                ? rawSource
                : "unknown") as RetrievedChunkPayload["source"];

              retrievedChunks.push({
                chunkId: typeof obj.chunkId === "string" ? obj.chunkId : undefined,
                filePath: String(obj.filePath),
                startLine: Number(obj.startLine),
                endLine: Number(obj.endLine),
                score: typeof obj.score === "number" ? obj.score : 0,
                source,
                symbolName: typeof obj.symbolName === "string" ? obj.symbolName : undefined,
                content: typeof obj.content === "string" ? obj.content : undefined,
              });
            }
          }
        }
      } catch {
        // Ignore malformed SSE JSON payload from upstream
      }
    };

    try {
      const agentRes = await fetch(`${config.AGENT_URL}/internal/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          runId,
          repoId: conversation.repoId.toString(),
          conversationHistory: history,
          question: parsed.data.content,
        }),
      });

      if (!agentRes.ok || !agentRes.body) {
        const errText = await agentRes.text();
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message: `Agent service error (${agentRes.status}): ${errText}`,
            retryable: agentRes.status >= 500,
          })}\n\n`,
        );
        res.end();
        return;
      }

      const reader = agentRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        sseBuffer += chunk;
        const parts = sseBuffer.split(/\r?\n\r?\n/);
        sseBuffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim()) {
            parseSseBlock(part);
          }
        }
      }
      if (sseBuffer.trim()) {
        parseSseBlock(sseBuffer);
      }

      if (assistantText.trim()) {
        await Message.create({
          conversationId: convId,
          role: "assistant",
          content: assistantText,
          citations,
          retrievedChunks,
          runId,
        });
      }
    } catch (err) {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          message: err instanceof Error ? err.message : "Streaming failed",
          retryable: true,
        })}\n\n`,
      );
    } finally {
      res.end();
    }
  });

  return router;
}

