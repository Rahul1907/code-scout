import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resetConfigCache } from "../lib/config.js";
import { AUTH_COOKIE_NAME, signAuthToken } from "../middleware/auth.js";
import { Conversation } from "../models/conversation.js";
import { Message } from "../models/message.js";
import { Repo } from "../models/repo.js";

describe("Conversation and Q&A SSE proxy routes", () => {
  const userId = "507f1f77bcf86cd799439011";
  const repoId = "507f1f77bcf86cd799439022";
  const convId = "507f1f77bcf86cd799439033";
  let cookie: string;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.AGENT_URL = "http://agent:8000";
    process.env.INTERNAL_API_KEY = "test-internal-key";
    resetConfigCache();

    const token = signAuthToken({ sub: userId, githubId: 42, login: "octocat" });
    cookie = `${AUTH_COOKIE_NAME}=${token}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigCache();
  });

  it("POST /api/repos/:id/conversations creates a conversation", async () => {
    const app = createApp();
    vi.spyOn(Repo, "findOne").mockReturnValueOnce({
      lean: async () => ({ _id: repoId, userId, status: "ready" }),
    } as never);
    vi.spyOn(Conversation, "create").mockResolvedValueOnce({
      _id: convId,
      userId,
      repoId,
      title: "New conversation",
    } as never);

    const res = await request(app)
      .post(`/api/repos/${repoId}/conversations`)
      .set("Cookie", [cookie])
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.conversation.title).toBe("New conversation");
  });

  it("POST /api/conversations/:id/messages proxies SSE and saves assistant message with citations", async () => {
    const app = createApp();
    const saveMock = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(Conversation, "findOne").mockResolvedValueOnce({
      _id: convId,
      userId,
      repoId,
      title: "New conversation",
      save: saveMock,
    } as never);
    vi.spyOn(Repo, "findOne").mockReturnValueOnce({
      lean: async () => ({ _id: repoId, userId, status: "ready" }),
    } as never);
    vi.spyOn(Message, "find").mockReturnValueOnce({
      sort: () => ({
        limit: () => ({
          lean: async () => [],
        }),
      }),
    } as never);

    const msgCreateSpy = vi
      .spyOn(Message, "create")
      .mockResolvedValue({} as never);

    const ssePayload = [
      'event: run_started\ndata: {"runId":"r1"}\n\n',
      'event: retrieval_debug\ndata: {"chunks":[{"filePath":"starlette/routing.py","startLine":10,"endLine":20,"score":0.95,"source":"both"}]}\n\n',
      'event: token\ndata: {"text":"Routing is in "}\n\n',
      'event: token\ndata: {"text":"[starlette/routing.py:10-20]."}\n\n',
      'event: citation\ndata: {"filePath":"starlette/routing.py","startLine":10,"endLine":20}\n\n',
      'event: run_completed\ndata: {"runId":"r1","totals":{"tokensIn":10,"tokensOut":5,"llmCalls":1,"durationMs":50}}\n\n',
    ].join("");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages`)
      .set("Cookie", [cookie])
      .send({ content: "Where is routing handled?", mode: "ask" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: retrieval_debug");
    expect(res.text).toContain("event: citation");
    expect(res.text).toContain("starlette/routing.py");

    expect(msgCreateSpy).toHaveBeenCalledTimes(2);
    expect(msgCreateSpy).toHaveBeenNthCalledWith(1, {
      conversationId: convId,
      role: "user",
      content: "Where is routing handled?",
    });
    expect(msgCreateSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        conversationId: convId,
        role: "assistant",
        content: "Routing is in [starlette/routing.py:10-20].",
        citations: [{ filePath: "starlette/routing.py", startLine: 10, endLine: 20 }],
        retrievedChunks: [
          expect.objectContaining({
            filePath: "starlette/routing.py",
            startLine: 10,
            endLine: 20,
            score: 0.95,
            source: "both",
          }),
        ],
      }),
    );
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});

