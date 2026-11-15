import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { getConfig, isEditAllowed } from "../lib/config.js";
import { encryptToken } from "../lib/crypto.js";
import {
  AUTH_COOKIE_NAME,
  type AuthenticatedRequest,
  requireAuth,
  signAuthToken,
} from "../middleware/auth.js";
import { User } from "../models/user.js";

const OAUTH_STATE_COOKIE = "codescout_oauth_state";

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export function createAuthRouter(): Router {
  const router = Router();

  router.get("/auth/github", (_req: Request, res: Response) => {
    const config = getConfig();
    if (!config.GITHUB_OAUTH_CLIENT_ID || !config.GITHUB_OAUTH_CLIENT_SECRET) {
      res.status(500).json({ error: "GitHub OAuth is not configured" });
      return;
    }

    const state = crypto.randomBytes(16).toString("hex");
    const isProd = config.NODE_ENV === "production";

    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      client_id: config.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: `${config.APP_URL}/api/auth/github/callback`,
      scope: "read:user public_repo",
      state,
    });

    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  router.get("/auth/github/callback", async (req: Request, res: Response) => {
    const config = getConfig();
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expectedState =
      typeof req.cookies?.[OAUTH_STATE_COOKIE] === "string"
        ? req.cookies[OAUTH_STATE_COOKIE]
        : "";

    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

    if (!code || !state || !expectedState || state !== expectedState) {
      res.status(400).json({ error: "Invalid OAuth state or missing code" });
      return;
    }

    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.GITHUB_OAUTH_CLIENT_ID,
          client_secret: config.GITHUB_OAUTH_CLIENT_SECRET,
          code,
          redirect_uri: `${config.APP_URL}/api/auth/github/callback`,
        }),
      });

      if (!tokenRes.ok) {
        res.status(502).json({ error: "Failed to exchange GitHub OAuth code" });
        return;
      }

      const tokenData = (await tokenRes.json()) as GitHubTokenResponse;
      if (!tokenData.access_token) {
        res.status(400).json({
          error: tokenData.error_description || tokenData.error || "Missing GitHub access token",
        });
        return;
      }

      const profileRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "CodeScout",
        },
      });

      if (!profileRes.ok) {
        res.status(502).json({ error: "Failed to fetch GitHub user profile" });
        return;
      }

      const profile = (await profileRes.json()) as GitHubUserProfile;
      const encryptedAccessToken = encryptToken(
        tokenData.access_token,
        config.TOKEN_ENCRYPTION_KEY,
      );

      const user = await User.findOneAndUpdate(
        { githubId: profile.id },
        {
          $set: {
            login: profile.login,
            name: profile.name ?? "",
            avatarUrl: profile.avatar_url ?? "",
            accessTokenEncrypted: encryptedAccessToken,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      const jwtToken = signAuthToken({
        sub: user._id.toString(),
        githubId: user.githubId,
        login: user.login,
      });

      const isProd = config.NODE_ENV === "production";
      res.cookie(AUTH_COOKIE_NAME, jwtToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.redirect(`${config.APP_URL}/dashboard`);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", service: "api", msg: "OAuth callback failed", error: String(err) }));
      res.status(500).json({ error: "GitHub authentication failed" });
    }
  });

  router.post("/auth/logout", (_req: Request, res: Response) => {
    const config = getConfig();
    res.clearCookie(AUTH_COOKIE_NAME, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    res.status(200).json({ ok: true });
  });

  router.get("/me", requireAuth, async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const user = await User.findById(auth.sub).select("-accessTokenEncrypted").lean();
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const config = getConfig();
    res.status(200).json({
      id: user._id.toString(),
      githubId: user.githubId,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      canEdit: isEditAllowed(user.login, config.EDIT_ALLOWLIST),
    });
  });

  return router;
}

