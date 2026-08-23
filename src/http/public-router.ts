import { randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import type { MetricsStore } from "../metrics.js";
import { PublicController, type PublicControllerOptions } from "./public-controller.js";

export type PublicRouterOptions = PublicControllerOptions & { metrics?: MetricsStore };
function requestId(request: Request): string { const provided = request.header("x-request-id"); return provided && /^[A-Za-z0-9_-]{8,128}$/.test(provided) ? provided : randomBytes(12).toString("hex"); }
function sendError(response: Response, error: unknown, id: string): void {
  let mapped = error instanceof AppError ? error : new AppError("INTERNAL", "request failed", 500);
  if (error instanceof ZodError) mapped = new AppError("BAD_REQUEST", "request validation failed", 400, { issues: error.issues });
  response.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, ...(mapped.details ? { details: mapped.details } : {}), requestId: id } });
}
export function createPublicRouter(options: PublicRouterOptions): Router {
  const router = express.Router();
  const controller = new PublicController(options);
  const rate = new Map<string, { count: number; resetAt: number }>();
  router.use((request, response, next) => {
    const id = requestId(request); request.headers["x-request-id"] = id; response.setHeader("X-Request-ID", id); options.metrics?.increment("api.requests");
    if (request.method === "POST" && request.path.endsWith("/attempts")) {
      const now = Date.now(); const key = request.ip || "unknown"; const entry = rate.get(key);
      const current = !entry || entry.resetAt <= now ? { count: 1, resetAt: now + 60_000 } : { ...entry, count: entry.count + 1 }; rate.set(key, current);
      if (current.count > 60) { response.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1_000)); sendError(response, new AppError("RATE_LIMITED", "too many attempt submissions", 429), id); return; }
    }
    next();
  });
  router.use(express.json({ limit: "128kb" }));
  const handle = (handler: (request: Request, response: Response) => Promise<void>) => async (request: Request, response: Response) => { try { await handler(request, response); } catch (error) { sendError(response, error, requestId(request)); } };

  router.get("/openapi.json", handle(controller.openApi));
  router.get("/daily-games/today", handle(controller.today));
  router.get("/daily-games", handle(controller.dailyRange));
  router.get("/daily-games/:date", handle(controller.dailyByDate));
  router.get("/spots/:spotId", handle(controller.spot));
  router.post("/spots/:spotId/attempts", handle(controller.createAttempt));
  router.get("/attempts/:attemptId", handle(controller.attempt));
  router.get("/users/me/stats", handle(controller.stats));
  router.get("/users/me/attempts", handle(controller.attemptHistory));
  return router;
}
