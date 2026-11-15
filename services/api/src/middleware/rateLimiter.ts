import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../lib/config.js";
import { AUTH_COOKIE_NAME, verifyAuthToken, type AuthenticatedRequest } from "./auth.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory sliding/fixed window store
const ipStore = new Map<string, RateLimitEntry>();
const userStore = new Map<string, RateLimitEntry>();

export function resetRateLimitStores(): void {
  ipStore.clear();
  userStore.clear();
}

function checkAndIncrement(
  store: Map<string, RateLimitEntry>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  let entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + windowMs };
    store.set(key, entry);
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  entry.count += 1;
  const remaining = Math.max(0, limit - entry.count);
  const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);

  return {
    allowed: entry.count <= limit,
    remaining,
    retryAfterSeconds,
  };
}

export function rateLimiter(options?: {
  maxPerIp?: number;
  maxPerUser?: number;
  windowSeconds?: number;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate limiting in test environment unless explicitly testing rate limiter
    const config = getConfig();
    const windowSeconds = options?.windowSeconds ?? config.RATE_LIMIT_WINDOW_SECONDS ?? 60;
    const windowMs = windowSeconds * 1000;
    const maxPerIp = options?.maxPerIp ?? config.RATE_LIMIT_MAX_PER_IP ?? 120;
    const maxPerUser = options?.maxPerUser ?? config.RATE_LIMIT_MAX_PER_USER ?? 60;

    const now = Date.now();

    // 1. Check IP rate limit
    const ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
    const ipResult = checkAndIncrement(ipStore, ip, maxPerIp, windowMs, now);

    res.setHeader("X-RateLimit-Limit-IP", maxPerIp);
    res.setHeader("X-RateLimit-Remaining-IP", ipResult.remaining);

    if (!ipResult.allowed) {
      res.setHeader("Retry-After", ipResult.retryAfterSeconds);
      res.status(429).json({
        error: "Too many requests from this IP address. Please slow down.",
      });
      return;
    }

    // 2. Try to identify authenticated user (if auth middleware hasn't run yet)
    let userId = (req as AuthenticatedRequest).auth?.sub;
    if (!userId) {
      const cookieToken =
        typeof req.cookies?.[AUTH_COOKIE_NAME] === "string"
          ? req.cookies[AUTH_COOKIE_NAME]
          : undefined;
      const authHeader = req.headers.authorization;
      const bearerToken =
        authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
      const token = cookieToken || bearerToken;
      if (token) {
        try {
          const payload = verifyAuthToken(token);
          userId = payload.sub;
        } catch {
          // unauthenticated or invalid token, skip user rate limit
        }
      }
    }

    if (userId) {
      const userResult = checkAndIncrement(userStore, userId, maxPerUser, windowMs, now);
      res.setHeader("X-RateLimit-Limit-User", maxPerUser);
      res.setHeader("X-RateLimit-Remaining-User", userResult.remaining);

      if (!userResult.allowed) {
        res.setHeader("Retry-After", userResult.retryAfterSeconds);
        res.status(429).json({
          error: "Too many requests for this user account. Please slow down.",
        });
        return;
      }
    }

    next();
  };
}
