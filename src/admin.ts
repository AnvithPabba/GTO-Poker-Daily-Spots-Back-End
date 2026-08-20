import express, { type Request, type Response, type Router } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { approveSpotVersion, assertLifecycleTransition, countFutureCoverage, scheduleSpotVersion } from "./publication.js";
import { SolverJobStatus, SpotVersionStatus } from "@prisma/client";
import type { MetricsStore } from "./metrics.js";

function loopback(request: Request): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function denied(response: Response): void { response.status(403).json({ code: "FORBIDDEN", message: "admin is available only from loopback", requestId: response.getHeader("X-Request-ID") ?? "admin" }); }

export function createAdminRouter(prisma: PrismaClient, metrics?: MetricsStore): Router {
  const router = express.Router();
  router.use((request, response, next) => loopback(request) ? next() : denied(response));
  async function audit(request: Request, operation: string, targetId: string, metadata?: unknown): Promise<void> {
    await prisma.adminAudit.create({ data: { actor: request.header("x-admin-actor")?.slice(0, 128) ?? null, operation, targetId, ...(metadata === undefined ? {} : { metadata: metadata as Prisma.InputJsonValue }) } });
  }
  router.get("/status", async (_request, response) => response.json({ ok: true, service: "admin" }));
  router.get("/metrics", async (_request, response) => response.json(metrics?.snapshot() ?? { counters: {}, gauges: {} }));
  router.get("/templates", async (_request, response, next) => { try { response.json(await prisma.solverTemplate.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, familyId: true, version: true, name: true, status: true, createdAt: true } })); } catch (error) { next(error); } });
  router.get("/jobs", async (_request, response, next) => { try { response.json(await prisma.solverJob.findMany({ orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 100, select: { id: true, templateId: true, status: true, attemptCount: true, maxAttempts: true, nextAttemptAt: true, lastErrorCode: true, createdAt: true } })); } catch (error) { next(error); } });
  router.post("/jobs/reorder", async (request, response, next) => { try {
    const items = Array.isArray(request.body?.items) ? request.body.items.filter((item: unknown): item is { id: string; priority: number } => Boolean(item && typeof item === "object" && "id" in item && typeof item.id === "string" && "priority" in item && Number.isInteger(item.priority))) : [];
    if (!items.length || items.length > 100) return response.status(400).json({ code: "BAD_REQUEST", message: "items must contain 1-100 jobs" });
    await prisma.$transaction(async (tx) => { for (const item of items) await tx.solverJob.update({ where: { id: item.id }, data: { priority: item.priority } }); });
    await audit(request, "solver_job.reorder", "batch", { count: items.length });
    response.json({ updated: items.length });
  } catch (error) { next(error); } });
  router.get("/spots/:spotId/versions", async (request, response, next) => { try { response.json(await prisma.spotVersion.findMany({ where: { spotId: request.params.spotId }, orderBy: { version: "desc" }, select: { id: true, version: true, status: true, validationReport: true, createdAt: true, approvedAt: true, scheduledAt: true, publishedAt: true } })); } catch (error) { next(error); } });
  router.post("/versions/:versionId/approve", async (request, response, next) => { try { const result = await approveSpotVersion(prisma, request.params.versionId); await audit(request, "spot_version.approve", request.params.versionId); response.json(result); } catch (error) { next(error); } });
  router.post("/versions/:versionId/schedule", async (request, response, next) => { try { const date = typeof request.body?.publicationDate === "string" ? request.body.publicationDate : ""; const order = Number(request.body?.slotOrder); const result = await scheduleSpotVersion(prisma, request.params.versionId, date, order); await audit(request, "spot_version.schedule", request.params.versionId, { publicationDate: date, slotOrder: order }); response.status(201).json(result); } catch (error) { next(error); } });
  router.post("/versions/:versionId/hold", async (request, response, next) => {
    try {
      const version = await prisma.spotVersion.findUniqueOrThrow({ where: { id: request.params.versionId } });
      assertLifecycleTransition(version.status, SpotVersionStatus.REJECTED);
      const result = await prisma.spotVersion.update({ where: { id: request.params.versionId }, data: { status: SpotVersionStatus.REJECTED, validationReport: { reason: "held by local admin" } }, select: { id: true, status: true } });
      await audit(request, "spot_version.hold", request.params.versionId);
      response.json(result);
    } catch (error) { next(error); }
  });
  router.get("/calendar", async (request, response, next) => { try {
    const from = typeof request.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(request.query.from) ? new Date(`${request.query.from}T00:00:00.000Z`) : new Date();
    const to = typeof request.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(request.query.to) ? new Date(`${request.query.to}T00:00:00.000Z`) : new Date(from.getTime() + 7 * 86_400_000);
    response.json(await prisma.publicationSlot.findMany({ where: { publicationDate: { gte: from, lte: to } }, orderBy: [{ publicationDate: "asc" }, { slotOrder: "asc" }], select: { id: true, publicationDate: true, slotOrder: true, status: true, spotVersionId: true } }));
  } catch (error) { next(error); } });
  router.get("/coverage", async (_request, response, next) => { try { const coverage = await countFutureCoverage(prisma); response.json({ coverage, target: 7, belowThree: coverage < 3 }); } catch (error) { next(error); } });
  router.get("/audit", async (_request, response, next) => { try { response.json(await prisma.adminAudit.findMany({ orderBy: { createdAt: "desc" }, take: 100 })); } catch (error) { next(error); } });
  router.post("/jobs/:jobId/retry", async (request, response, next) => { try {
    const job = await prisma.solverJob.update({ where: { id: request.params.jobId }, data: { status: SolverJobStatus.QUEUED, nextAttemptAt: new Date(), lastErrorCode: null, lastErrorMessage: null }, select: { id: true, status: true, nextAttemptAt: true } });
    await audit(request, "solver_job.retry", request.params.jobId); response.json(job);
  } catch (error) { next(error); } });
  router.post("/jobs/:jobId/hold", async (request, response, next) => { try {
    const job = await prisma.solverJob.update({ where: { id: request.params.jobId }, data: { status: SolverJobStatus.HELD }, select: { id: true, status: true } });
    await audit(request, "solver_job.hold", request.params.jobId); response.json(job);
  } catch (error) { next(error); } });
  router.delete("/jobs/:jobId", async (request, response, next) => { try {
    const job = await prisma.solverJob.update({ where: { id: request.params.jobId }, data: { status: SolverJobStatus.CANCELLED }, select: { id: true, status: true } });
    await audit(request, "solver_job.cancel", request.params.jobId); response.json(job);
  } catch (error) { next(error); } });
  router.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => response.status(500).json({ code: "ADMIN_FAILED", message: error instanceof Error ? error.message : "admin operation failed" }));
  return router;
}

export { loopback as isLoopbackRequest };
