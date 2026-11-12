import crypto from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resetConfigCache } from "../lib/config.js";
import { decryptToken } from "../lib/crypto.js";
import { AUTH_COOKIE_NAME, signAuthToken } from "../middleware/auth.js";
import { User } from "../models/user.js";

describe("GitHub OAuth & Auth routes", () => {
  const encryptionKey = crypto.randomBytes(32).toString("hex");

  beforeEach(() => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "test-client-secret";
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
    process.env.APP_URL = "http://localhost:3000";
    resetConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigCache();
  });

  it("GET /api/auth/github redirects to GitHub with state cookie and expected scopes", async () => {
    const app = createApp();
    const res = await request(app).get("/api/auth/github");

    expect(res.status).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("scope=read%3Auser+public_repo");
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("codescout_oauth_state="))).toBe(true);
  });

  it("GET /api/auth/github/callback upserts user, encrypts token, and sets httpOnly JWT cookie", async () => {
    const app = createApp();

    const startRes = await request(app).get("/api/auth/github");
    const stateCookie = (startRes.headers["set-cookie"] as unknown as string[])[0] ?? "";
    const stateMatch = /codescout_oauth_state=([^;]+)/.exec(stateCookie);
    const state = stateMatch?.[1] ?? "";

    const fakeUser = {
      _id: { toString: () => "507f1f77bcf86cd799439011" },
      githubId: 42,
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
    };

    const findOneAndUpdateSpy = vi
      .spyOn(User, "findOneAndUpdate")
      .mockResolvedValueOnce(fakeUser as never);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_real_token_123" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42,
            login: "octocat",
            name: "Octo Cat",
            avatar_url: "https://avatars.githubusercontent.com/u/42",
          }),
          { status: 200 },
        ),
      );

    const callbackRes = await request(app)
      .get(`/api/auth/github/callback?code=oauth-code&state=${state}`)
      .set("Cookie", [`codescout_oauth_state=${state}`]);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toBe("http://localhost:3000/dashboard");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(1);

    const updateArg = findOneAndUpdateSpy.mock.calls[0]?.[1] as {
      $set: { accessTokenEncrypted: string };
    };
    expect(decryptToken(updateArg.$set.accessTokenEncrypted, encryptionKey)).toBe(
      "gho_real_token_123",
    );

    const setCookies = callbackRes.headers["set-cookie"] as unknown as string[];
    const authCookie = setCookies.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(authCookie).toBeDefined();
    expect(authCookie).toContain("HttpOnly");
    expect(authCookie).toContain("SameSite=Lax");
  });

  it("GET /api/me returns 401 without cookie and returns profile when authenticated", async () => {
    const app = createApp();

    const unauthRes = await request(app).get("/api/me");
    expect(unauthRes.status).toBe(401);

    const token = signAuthToken({
      sub: "507f1f77bcf86cd799439011",
      githubId: 42,
      login: "octocat",
    });

    vi.spyOn(User, "findById").mockReturnValueOnce({
      select: () => ({
        lean: async () => ({
          _id: { toString: () => "507f1f77bcf86cd799439011" },
          githubId: 42,
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars.githubusercontent.com/u/42",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    } as never);

    const meRes = await request(app)
      .get("/api/me")
      .set("Cookie", [`${AUTH_COOKIE_NAME}=${token}`]);

    expect(meRes.status).toBe(200);
    expect(meRes.body).toEqual({
      id: "507f1f77bcf86cd799439011",
      githubId: 42,
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("POST /api/auth/logout clears auth cookie", async () => {
    const app = createApp();
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const setCookies = res.headers["set-cookie"] as unknown as string[];
    const cleared = setCookies.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(cleared).toContain(`${AUTH_COOKIE_NAME}=;`);
  });
});

