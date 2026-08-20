import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";

import { loadConfig } from "./config.js";
import { createHealthApp } from "./health.js";
import { createPrismaClient } from "./db.js";
import { ensureQueueFoundation, ensureQueueSchedules } from "./queue.js";
import { installScheduledJobHandlers } from "./jobs.js";

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  });
  // Keep the liveness server up during a database outage so readiness can
  // report 503 and recover when PostgreSQL returns.
  pool.on("error", (error: Error) => {
    console.error(`worker database pool error: ${error.message}`);
  });
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: config.PG_BOSS_SCHEMA,
    // The initializer creates and owns this schema, so the runtime role does
    // not need CREATE privilege on the database itself.
    createSchema: false,
  });
  boss.on("error", (error: Error) => {
    console.error(`worker queue error: ${error.message}`);
  });
  await boss.start();
  await ensureQueueFoundation(boss);
  await ensureQueueSchedules(boss);
  const prisma = createPrismaClient(config.DATABASE_URL);
  await installScheduledJobHandlers(boss, prisma);

  const app = createHealthApp({
    corsOrigin: config.CORS_ORIGIN,
    pool,
    service: "worker",
  });
  const server = createServer(app);
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(config.WORKER_PORT, config.WORKER_HOST, () => resolveServer());
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`worker stopping (${signal})`);
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    await boss.stop({ close: true, graceful: true });
    await pool.end();
    await prisma.$disconnect();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  console.log(`worker listening on ${config.WORKER_HOST}:${config.WORKER_PORT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startWorker().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
