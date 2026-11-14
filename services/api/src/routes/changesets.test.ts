import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resetConfigCache } from "../lib/config.js";
import { AUTH_COOKIE_NAME, signAuthToken } from "../middleware/auth.js";
import { AgentRun } from "../models/agentRun.js";
import { Changeset } from "../models/changeset.js";

describe("Changesets routes", () => {
  const userId = "507f1f77bcf86cd799439011";
  const runId = "run-test-123";
  const changesetId = "cs-test-456";
  const repoId = "507f1f77bcf86cd799439022";
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

  it("GET /api/runs/:id/changeset returns changeset when exists", async () => {
    const app = createApp();
    vi.spyOn(Changeset, "findOne").mockReturnValueOnce({
      lean: async () => ({
        _id: changesetId,
        runId,
        repoId,
        files: [{ path: "app.py", changeType: "modified", diff: "+new" }],
        status: "pending_review",
      }),
    } as never);

    const res = await request(app)
      .get(`/api/runs/${runId}/changeset`)
      .set("Cookie", [cookie]);

    expect(res.status).toBe(200);
    expect(res.body.changeset.runId).toBe(runId);
    expect(res.body.changeset.files).toHaveLength(1);
  });

  it("GET /api/runs/:id/changeset returns 404 when not found", async () => {
    const app = createApp();
    vi.spyOn(Changeset, "findOne").mockReturnValueOnce({
      lean: async () => null,
    } as never);

    const res = await request(app)
      .get(`/api/runs/${runId}/changeset`)
      .set("Cookie", [cookie]);

    expect(res.status).toBe(404);
  });

  it("POST /api/changesets/:id/approve marks changeset approved and run completed", async () => {
    const app = createApp();
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const mockDoc = {
      _id: changesetId,
      runId,
      repoId,
      status: "pending_review",
      save: saveMock,
    };
    vi.spyOn(Changeset, "findById").mockResolvedValueOnce(mockDoc as never);
    const updateRunMock = vi.spyOn(AgentRun, "updateOne").mockResolvedValueOnce({} as never);

    const res = await request(app)
      .post(`/api/changesets/${changesetId}/approve`)
      .set("Cookie", [cookie])
      .send({});

    expect(res.status).toBe(200);
    expect(mockDoc.status).toBe("approved");
    expect(saveMock).toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith(
      { runId },
      { $set: { status: "completed" } }
    );
  });

  it("POST /api/changesets/:id/reject discards worktree and marks run cancelled", async () => {
    const app = createApp();
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const mockDoc = {
      _id: changesetId,
      runId,
      repoId,
      status: "pending_review",
      save: saveMock,
    };
    vi.spyOn(Changeset, "findById").mockResolvedValueOnce(mockDoc as never);
    const updateRunMock = vi.spyOn(AgentRun, "updateOne").mockResolvedValueOnce({} as never);

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "discarded" }), { status: 200 })
    );

    const res = await request(app)
      .post(`/api/changesets/${changesetId}/reject`)
      .set("Cookie", [cookie])
      .send({});

    expect(res.status).toBe(200);
    expect(mockDoc.status).toBe("rejected");
    expect(saveMock).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://agent:8000/internal/runs/${runId}/discard`,
      expect.objectContaining({ method: "POST" })
    );
    expect(updateRunMock).toHaveBeenCalledWith(
      { runId },
      { $set: { status: "cancelled" } }
    );
  });
});
