import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { isEditAllowed } from "../lib/config.js";
import { rateLimiter, resetRateLimitStores } from "./rateLimiter.js";
import { signAuthToken } from "./auth.js";

describe("Rate Limiter Middleware", () => {
  beforeEach(() => {
    resetRateLimitStores();
  });

  it("allows requests under the IP limit and returns rate limit headers", async () => {
    const app = express();
    app.use(rateLimiter({ maxPerIp: 3, windowSeconds: 60 }));
    app.get("/test", (_req, res) => {
      res.json({ ok: true });
    });

    const res1 = await request(app).get("/test");
    expect(res1.status).toBe(200);
    expect(res1.headers["x-ratelimit-limit-ip"]).toBe("3");
    expect(res1.headers["x-ratelimit-remaining-ip"]).toBe("2");

    const res2 = await request(app).get("/test");
    expect(res2.status).toBe(200);
    expect(res2.headers["x-ratelimit-remaining-ip"]).toBe("1");

    const res3 = await request(app).get("/test");
    expect(res3.status).toBe(200);
    expect(res3.headers["x-ratelimit-remaining-ip"]).toBe("0");

    const res4 = await request(app).get("/test");
    expect(res4.status).toBe(429);
    expect(res4.headers["retry-after"]).toBeDefined();
    expect(res4.body.error).toContain("Too many requests from this IP");
  });

  it("enforces user-specific limits when authenticated", async () => {
    const app = express();
    app.use(express.json());
    app.use(rateLimiter({ maxPerIp: 10, maxPerUser: 2, windowSeconds: 60 }));
    app.get("/test", (_req, res) => {
      res.json({ ok: true });
    });

    const token = signAuthToken({ sub: "user-123", githubId: 1, login: "testuser" });

    const res1 = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res1.status).toBe(200);
    expect(res1.headers["x-ratelimit-limit-user"]).toBe("2");
    expect(res1.headers["x-ratelimit-remaining-user"]).toBe("1");

    const res2 = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res2.status).toBe(200);
    expect(res2.headers["x-ratelimit-remaining-user"]).toBe("0");

    const res3 = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res3.status).toBe(429);
    expect(res3.body.error).toContain("Too many requests for this user account");
  });

  it("allows isEditAllowed logic to correctly parse comma-separated logins", () => {
    expect(isEditAllowed("Rahul1907", "Rahul1907,octocat,dev")).toBe(true);
    expect(isEditAllowed("rahul1907", "Rahul1907,octocat")).toBe(true); // case-insensitive
    expect(isEditAllowed("stranger", "Rahul1907,octocat")).toBe(false);
    expect(isEditAllowed("anyone", "")).toBe(true); // Empty allowlist allows all
    expect(isEditAllowed("anyone", "   ")).toBe(true);
  });
});
