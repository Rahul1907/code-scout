import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resetConfigCache } from "../lib/config.js";
import { AUTH_COOKIE_NAME, signAuthToken } from "../middleware/auth.js";
import { AgentRun } from "../models/agentRun.js";
import { Changeset } from "../models/changeset.js";
import { PullRequest } from "../models/pullRequest.js";
import { Repo } from "../models/repo.js";

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

  it("POST /api/changesets/:id/pull-request returns 400 when GitHub App not installed", async () => {
    const app = createApp();
    const mockDoc = {
      _id: changesetId,
      runId,
      repoId,
      status: "approved",
    };
    vi.spyOn(Changeset, "findById").mockResolvedValueOnce(mockDoc as never);
    vi.spyOn(PullRequest, "findOne").mockReturnValueOnce({
      lean: async () => null,
    } as never);
    vi.spyOn(Repo, "findOne").mockResolvedValueOnce({
      _id: repoId,
      userId,
      fullName: "octocat/hello-world",
      githubInstallationId: null,
    } as never);

    const res = await request(app)
      .post(`/api/changesets/${changesetId}/pull-request`)
      .set("Cookie", [cookie]);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("GitHub App is not installed");
    expect(res.body.installUrl).toBeTruthy();
  });

  it("POST /api/changesets/:id/pull-request opens PR when app installed", async () => {
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
    vi.spyOn(PullRequest, "findOne").mockReturnValueOnce({
      lean: async () => null,
    } as never);
    vi.spyOn(Repo, "findOne").mockResolvedValueOnce({
      _id: repoId,
      userId,
      fullName: "octocat/hello-world",
      owner: "octocat",
      name: "hello-world",
      defaultBranch: "main",
      githubInstallationId: 12345,
    } as never);

    vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/generate-pr")) {
        return new Response(JSON.stringify({ title: "feat: update app", body: "## Summary" }), { status: 200 });
      }
      if (urlStr.includes("/commit-and-push")) {
        return new Response(JSON.stringify({ committed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const prCreatedMock = {
      _id: "pr-1",
      prNumber: 42,
      prUrl: "https://github.com/octocat/hello-world/pull/42",
      title: "feat: update app",
    };
    vi.spyOn(PullRequest, "create").mockResolvedValueOnce(prCreatedMock as never);
    vi.spyOn(AgentRun, "updateOne").mockResolvedValueOnce({} as never);

    const res = await request(app)
      .post(`/api/changesets/${changesetId}/pull-request`)
      .set("Cookie", [cookie]);

    expect(res.status).toBe(201);
    expect(res.body.pullRequest.prNumber).toBe(42);
    expect(res.body.pullRequest.prUrl).toBe("https://github.com/octocat/hello-world/pull/42");
    expect(saveMock).toHaveBeenCalled();
  });

  it("GET /api/changesets/:id/pull-request returns PR details", async () => {
    const app = createApp();
    vi.spyOn(PullRequest, "findOne").mockReturnValueOnce({
      lean: async () => ({
        _id: "pr-1",
        changesetId,
        runId,
        prNumber: 15,
        prUrl: "https://github.com/octocat/hello-world/pull/15",
      }),
    } as never);

    const res = await request(app)
      .get(`/api/changesets/${changesetId}/pull-request`)
      .set("Cookie", [cookie]);

    expect(res.status).toBe(200);
    expect(res.body.pullRequest.prNumber).toBe(15);
  });
});

