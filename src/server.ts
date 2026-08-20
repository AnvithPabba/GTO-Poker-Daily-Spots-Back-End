import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { createHealthApp } from "./health.js";
import { createPrismaClient } from "./db.js";
import { createPublicApiRouter } from "./api.js";
import { createAdminRouter } from "./admin.js";
import { InMemoryMetricsStore } from "./metrics.js";

export async function startApi(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  });
  const prisma = createPrismaClient(config.DATABASE_URL);
  const metrics = new InMemoryMetricsStore();
  // A transient database disconnect must make readiness fail, not terminate
  // the HTTP process. The health route reports the query failure explicitly.
  pool.on("error", (error: Error) => {
    console.error(`api database pool error: ${error.message}`);
  });
  const app = createHealthApp({
    corsOrigin: config.CORS_ORIGIN,
    pool,
    service: "api",
  });
  app.use("/api/v1", createPublicApiRouter({
    prisma,
    guestCookieHashSecret: config.GUEST_COOKIE_HASH_SECRET,
    guestCookieName: config.GUEST_COOKIE_NAME,
    secureCookies: config.NODE_ENV === "production",
  }));
  app.use("/api/v1/admin", createAdminRouter(prisma, metrics, undefined, { allowTrustedProxy: config.ADMIN_TRUSTED_PROXY && config.NODE_ENV !== "production" }));
  const server = createServer(app);

  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(config.API_PORT, config.API_HOST, () => resolveServer());
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`api stopping (${signal})`);
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    await pool.end();
    await prisma.$disconnect();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  console.log(`api listening on ${config.API_HOST}:${config.API_PORT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startApi().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
