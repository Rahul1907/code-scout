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

