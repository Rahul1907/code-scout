import fs from "node:fs";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  AGENT_URL: z.string().url().default("http://agent:8000"),
  INTERNAL_API_KEY: z.string().min(1).default("change-me"),
  GITHUB_OAUTH_CLIENT_ID: z.string().default(""),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().default(""),
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default("/secrets/github-app.pem"),
  GITHUB_APP_SLUG: z.string().default(""),
  GITHUB_APP_WEBHOOK_SECRET: z.string().default(""),
  JWT_SECRET: z.string().min(1).default("change-me"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1).default("change-me-32-bytes"),
  MONGODB_URI: z
    .string()
    .min(1)
    .default("mongodb://mongo:27017/codescout?directConnection=true"),
  REDIS_URL: z.string().min(1).default("redis://redis:6379"),
  MAX_REPO_SIZE_MB: z.coerce.number().int().positive().default(50),
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = envSchema.parse(process.env);
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function getGitHubAppPrivateKey(config: AppConfig): string {
  if (config.GITHUB_APP_PRIVATE_KEY) {
    const raw = config.GITHUB_APP_PRIVATE_KEY.trim();
    if (raw.includes("-----BEGIN") && raw.includes("PRIVATE KEY-----")) {
      return raw;
    }
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf-8");
      if (decoded.includes("-----BEGIN") && decoded.includes("PRIVATE KEY-----")) {
        return decoded;
      }
    } catch {
      // not base64
    }
    return raw;
  }

  if (config.GITHUB_APP_PRIVATE_KEY_PATH && fs.existsSync(config.GITHUB_APP_PRIVATE_KEY_PATH)) {
    return fs.readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
  }

  return "";
}

