import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  getGitHubAppInstallUrl,
  getGitHubAppJwt,
  getInstallationAccessToken,
  isGitHubAppConfigured,
  verifyWebhookSignature,
} from "../lib/githubApp.js";
import { AUTH_COOKIE_NAME, signAuthToken } from "../middleware/auth.js";
import { Repo } from "../models/repo.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("GitHub App Library", () => {
  const mockConfig = {
    NODE_ENV: "test" as const,
    PORT: 4000,
    APP_URL: "http://localhost:3000",
    API_URL: "http://localhost:4000",
    AGENT_URL: "http://agent:8000",
    INTERNAL_API_KEY: "test-key",
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "987654",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_PRIVATE_KEY_PATH: "",
    GITHUB_APP_SLUG: "test-scout-app",
    GITHUB_APP_WEBHOOK_SECRET: "whsec_test123",
    JWT_SECRET: "test-jwt-secret",
    TOKEN_ENCRYPTION_KEY: "01234567890123456789012345678901",
    MONGODB_URI: "mongodb://localhost:27017/test",
    REDIS_URL: "redis://localhost:6379",
    MAX_REPO_SIZE_MB: 50,
  };

  it("checks if GitHub App is configured", () => {
    expect(isGitHubAppConfigured(mockConfig)).toBe(true);
    expect(isGitHubAppConfigured({ ...mockConfig, GITHUB_APP_ID: "" })).toBe(false);
  });

  it("generates signed RS256 JWT for GitHub App", () => {
    const token = getGitHubAppJwt(mockConfig);
    expect(token).toBeTruthy();

    const decoded = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as jwt.JwtPayload;
    expect(decoded.iss).toBe("987654");
    expect(decoded.exp! - decoded.iat!).toBe(600);
  });

  it("throws when generating JWT without app ID or key", () => {
    expect(() => getGitHubAppJwt({ ...mockConfig, GITHUB_APP_ID: "" })).toThrow("GITHUB_APP_ID is not configured");
    expect(() => getGitHubAppJwt({ ...mockConfig, GITHUB_APP_PRIVATE_KEY: "" })).toThrow("private key is not configured");
  });

  it("exchanges App JWT for installation access token", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "ghs_test_token_12345",
          expires_at: "2026-11-14T19:30:00Z",
          permissions: { contents: "write", pull_requests: "write" },
        }),
        { status: 201 }
      )
    );

    const res = await getInstallationAccessToken(123456, mockConfig);
    expect(res.token).toBe("ghs_test_token_12345");
    expect(res.expiresAt).toBe("2026-11-14T19:30:00Z");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("generates correct install URL with state", () => {
    const url = getGitHubAppInstallUrl("6af829602178dd4fba04ca96", mockConfig);
    expect(url).toBe("https://github.com/apps/test-scout-app/installations/new?state=6af829602178dd4fba04ca96");
  });

  it("verifies webhook signature", () => {
    const payload = JSON.stringify({ action: "created" });
    const secret = "secret123";
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, "sha256=invalid", secret)).toBe(false);
  });
});

describe("GitHub App Routes", () => {
  const userId = "507f191e810c19729de860ea";
  const repoId = "507f191e810c19729de860eb";
  let cookie: string;

  beforeEach(() => {
    const token = signAuthToken({ sub: userId, login: "octocat", githubId: 12345 });
    cookie = `${AUTH_COOKIE_NAME}=${token}`;
    vi.restoreAllMocks();
  });

  it("GET /api/github/app/status returns configuration status", async () => {
    const app = createApp();
    const res = await request(app).get("/api/github/app/status");
    expect(res.status).toBe(200);
    expect(typeof res.body.configured).toBe("boolean");
  });

  it("GET /api/github/app/install-url returns install URL", async () => {
    const app = createApp();
    const res = await request(app).get("/api/github/app/install-url?state=test-state");
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("state=test-state");
  });

  it("GET /api/repos/:id/github returns installation status", async () => {
    const app = createApp();
    vi.spyOn(Repo, "findOne").mockReturnValueOnce({
      lean: async () => ({
        _id: repoId,
        userId,
        githubInstallationId: 78910,
      }),
    } as never);

    const res = await request(app)
      .get(`/api/repos/${repoId}/github`)
      .set("Cookie", [cookie]);

    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.installationId).toBe(78910);
  });

  it("POST /api/repos/:id/github/link links installation ID to repo", async () => {
    const app = createApp();
    vi.spyOn(Repo, "findOneAndUpdate").mockReturnValueOnce({
      lean: async () => ({
        _id: repoId,
        userId,
        githubInstallationId: 554433,
      }),
    } as never);

    const res = await request(app)
      .post(`/api/repos/${repoId}/github/link`)
      .set("Cookie", [cookie])
      .send({ installationId: 554433 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.installationId).toBe(554433);
  });

  it("GET /api/github/app/callback updates repo and redirects", async () => {
    const app = createApp();
    const updateSpy = vi.spyOn(Repo, "updateOne").mockResolvedValueOnce({} as never);

    const res = await request(app)
      .get(`/api/github/app/callback?installation_id=998877&setup_action=install&state=${repoId}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`/repos/${repoId}?github_installed=true`);
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: repoId },
      { $set: { githubInstallationId: 998877 } }
    );
  });
});
