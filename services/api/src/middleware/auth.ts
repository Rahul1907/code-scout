import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getConfig } from "../lib/config.js";

export const AUTH_COOKIE_NAME = "codescout_token";

export interface AuthJwtPayload {
  sub: string;
  githubId: number;
  login: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthJwtPayload;
}

export function signAuthToken(payload: AuthJwtPayload): string {
  const { JWT_SECRET } = getConfig();
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyAuthToken(token: string): AuthJwtPayload {
  const { JWT_SECRET } = getConfig();
  const decoded = jwt.verify(token, JWT_SECRET);
  if (typeof decoded === "string" || !decoded.sub || typeof decoded.login !== "string") {
    throw new Error("Invalid auth token payload");
  }
  return {
    sub: String(decoded.sub),
    githubId: Number(decoded.githubId),
    login: decoded.login,
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookieToken =
    typeof req.cookies?.[AUTH_COOKIE_NAME] === "string"
      ? req.cookies[AUTH_COOKIE_NAME]
      : undefined;
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;

  const token = cookieToken || bearerToken;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    (req as AuthenticatedRequest).auth = verifyAuthToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

