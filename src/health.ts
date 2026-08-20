import express, { type Express } from "express";
import type { Pool } from "pg";

export type HealthService = "api" | "worker";

type HealthOptions = {
  pool: Pool;
  service: HealthService;
  corsOrigin: string;
};

export function liveHealthPayload(service: HealthService): { service: HealthService; status: "ok" } {
  return { service, status: "ok" };
}

export async function readinessPayload(
  pool: Pick<Pool, "query">,
  service: HealthService,
): Promise<{
  body: { checks: { database: "failed" | "ok" }; service: HealthService; status: "ok" | "unready" };
  statusCode: 200 | 503;
}> {
  try {
    await pool.query("SELECT 1");
    return { body: { checks: { database: "ok" }, service, status: "ok" }, statusCode: 200 };
  } catch {
    return { body: { checks: { database: "failed" }, service, status: "unready" }, statusCode: 503 };
  }
}

export function createHealthApp({ pool, service, corsOrigin }: HealthOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Origin", corsOrigin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Accept,Content-Type,If-None-Match,X-Request-ID");
    next();
  });

  app.options(/.*/, (_request, response) => response.status(204).end());

  app.get("/health/live", (_request, response) => {
    response.status(200).json(liveHealthPayload(service));
  });

  app.get("/health/ready", async (_request, response) => {
    const result = await readinessPayload(pool, service);
    response.status(result.statusCode).json(result.body);
  });

  return app;
}
