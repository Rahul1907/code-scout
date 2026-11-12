import crypto from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resetConfigCache } from "../lib/config.js";
import { encryptToken } from "../lib/crypto.js";
import { AUTH_COOKIE_NAME, signAuthToken } from "../middleware/auth.js";
import { Repo } from "../models/repo.js";
import { User } from "../models/user.js";
import * as indexingQueue from "../queues/indexing.js";

describe("Repo routes", () => {
  const encryptionKey = crypto.randomBytes(32).toString("hex");
  const userId = "507f1f77bcf86cd799439011";
  let cookie: string;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
    process.env.MAX_REPO_SIZE_MB = "50";
    resetConfigCache();

    const token = signAuthToken({ sub: userId, githubId: 42, login: "octocat" });
    cookie = `${AUTH_COOKIE_NAME}=${token}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigCache();
  });

  it("GET /api/github/repos lists authenticated user's public repos", async () => {
    const app = createApp();
    const encrypted = encryptToken("gho_user_token", encryptionKey);

    vi.spyOn(User, "findById").mockReturnValueOnce({
      lean: async () => ({ _id: userId, accessTokenEncrypted: encrypted }),
    } as never);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 1,
            name: "demo",
            full_name: "octocat/demo",
            owner: { login: "octocat" },
            private: false,
            default_branch: "main",
            size: 512,
            description: "Demo repo",
            language: "TypeScript",
            html_url: "https://github.com/octocat/demo",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]),
        { status: 200 },
      ),
    );

    const res = await request(app).get("/api/github/repos").set("Cookie", [cookie]);
    expect(res.status).toBe(200);
    expect(res.body.repos).toHaveLength(1);
    expect(res.body.repos[0].fullName).toBe("octocat/demo");
  });

  it("POST /api/repos rejects repos larger than MAX_REPO_SIZE_MB", async () => {
    const app = createApp();
    const encrypted = encryptToken("gho_user_token", encryptionKey);

    vi.spyOn(User, "findById").mockReturnValueOnce({
      lean: async () => ({ _id: userId, accessTokenEncrypted: encrypted }),
    } as never);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 2,
          name: "huge-repo",
          full_name: "octocat/huge-repo",
          owner: { login: "octocat" },
          private: false,
          default_branch: "main",
          size: 60 * 1024, // 60 MB > 50 MB
          description: "",
          language: "Python",
          html_url: "https://github.com/octocat/huge-repo",
          updated_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const res = await request(app)
      .post("/api/repos")
      .set("Cookie", [cookie])
      .send({ fullName: "octocat/huge-repo" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("50 MB");
  });

  it("POST /api/repos creates repo record and enqueues BullMQ job", async () => {
    const app = createApp();
    const encrypted = encryptToken("gho_user_token", encryptionKey);

    vi.spyOn(User, "findById").mockReturnValueOnce({
      lean: async () => ({ _id: userId, accessTokenEncrypted: encrypted }),
    } as never);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 3,
          name: "hello-world",
          full_name: "octocat/hello-world",
          owner: { login: "octocat" },
          private: false,
          default_branch: "main",
          size: 120,
          description: "Small repo",
          language: "TypeScript",
          html_url: "https://github.com/octocat/hello-world",
          updated_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    vi.spyOn(Repo, "findOne").mockReturnValueOnce({
      lean: async () => null,
    } as never);

    const createdRepo = {
      _id: { toString: () => "507f1f77bcf86cd799439022" },
      userId,
      owner: "octocat",
      name: "hello-world",
      fullName: "octocat/hello-world",
      defaultBranch: "main",
      status: "pending",
    };
    vi.spyOn(Repo, "create").mockResolvedValueOnce(createdRepo as never);
    const enqueueSpy = vi
      .spyOn(indexingQueue, "enqueueIndexingJob")
      .mockResolvedValueOnce("job-123");

    const res = await request(app)
      .post("/api/repos")
      .set("Cookie", [cookie])
      .send({ fullName: "octocat/hello-world" });

    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe("job-123");
    expect(enqueueSpy).toHaveBeenCalledWith({
      repoId: "507f1f77bcf86cd799439022",
      cloneUrl: "https://github.com/octocat/hello-world.git",
      defaultBranch: "main",
      userId,
    });
  });

  it("GET /api/repos/:id/file blocks path traversal", async () => {
    const app = createApp();
    vi.spyOn(Repo, "findOne").mockReturnValueOnce({
      lean: async () => ({ _id: "507f1f77bcf86cd799439022", userId }),
    } as never);

    const res = await request(app)
      .get("/api/repos/507f1f77bcf86cd799439022/file?path=../../etc/passwd")
      .set("Cookie", [cookie]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid file path");
  });
});

