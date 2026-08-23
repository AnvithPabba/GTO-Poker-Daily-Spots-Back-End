import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WORKER_HOST: z.string().default("0.0.0.0"),
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:4173"),
  PG_BOSS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("pgboss"),
  GUEST_COOKIE_HASH_SECRET: z.string().min(16).default("local-development-guest-cookie-secret"),
  GUEST_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("poker_guest"),
  ADMIN_ENABLED: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
  ADMIN_TRUSTED_PROXY: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type RuntimeConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid backend environment: ${details}`);
  }
  return result.data;
}
