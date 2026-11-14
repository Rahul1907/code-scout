import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { type AppConfig, getConfig, getGitHubAppPrivateKey } from "./config.js";

export interface InstallationTokenResponse {
  token: string;
  expiresAt: string;
  permissions?: Record<string, string>;
  repositorySelection?: "all" | "selected";
}

export function isGitHubAppConfigured(config?: AppConfig): boolean {
  const cfg = config ?? getConfig();
  const privateKey = getGitHubAppPrivateKey(cfg);
  return Boolean(cfg.GITHUB_APP_ID.trim() && privateKey.trim());
}

export function getGitHubAppJwt(config?: AppConfig): string {
  const cfg = config ?? getConfig();
  const privateKey = getGitHubAppPrivateKey(cfg);

  if (!cfg.GITHUB_APP_ID.trim()) {
    throw new Error("GITHUB_APP_ID is not configured");
  }
  if (!privateKey.trim()) {
    throw new Error("GitHub App private key is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 60 seconds clock drift tolerance
    exp: now + 540, // 9 minutes (max allowed by GitHub is 10 min)
    iss: cfg.GITHUB_APP_ID.trim(),
  };

  return jwt.sign(payload, privateKey, { algorithm: "RS256" });
}

export async function getInstallationAccessToken(
  installationId: number,
  config?: AppConfig,
): Promise<InstallationTokenResponse> {
  const cfg = config ?? getConfig();
  const appJwt = getGitHubAppJwt(cfg);

  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "CodeScout-Agent",
    },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(
      `Failed to generate installation token from GitHub (${res.status}): ${errorBody}`,
    );
  }

  const data = (await res.json()) as {
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
    repository_selection?: "all" | "selected";
  };

  return {
    token: data.token,
    expiresAt: data.expires_at,
    permissions: data.permissions,
    repositorySelection: data.repository_selection,
  };
}

export function getGitHubAppInstallUrl(state?: string, config?: AppConfig): string {
  const cfg = config ?? getConfig();
  const slug = cfg.GITHUB_APP_SLUG || "codescout-agent";
  const base = `https://github.com/apps/${slug}/installations/new`;
  if (!state) return base;
  return `${base}?state=${encodeURIComponent(state)}`;
}

export function verifyWebhookSignature(
  rawPayload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=") || !secret) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawPayload)
    .digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expectedSignature),
    );
  } catch {
    return false;
  }
}
