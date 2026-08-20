import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { Prisma, PublicationSlotStatus, SpotVersionStatus, type PrismaClient } from "@prisma/client";
import { archiveResponseSchema, attemptResponseSchema, publicSpotSchema, todayResponseSchema, validateAttemptForSpot, type PublicSpot } from "@poker-trainer/contracts";
import { pacificDate } from "./publication.js";
import { scoreHands } from "./scoring.js";
import { AppError } from "./errors.js";
import { ZodError } from "zod";
import type { IdentityProvider } from "./ports.js";
import { requirePrincipal } from "./auth.js";
import type { MetricsStore } from "./metrics.js";

type ApiOptions = {
  prisma: PrismaClient;
  guestCookieHashSecret: string;
  guestCookieName: string;
  secureCookies: boolean;
  identityProvider?: IdentityProvider;
  metrics?: MetricsStore;
};

function errorResponse(response: Response, status: number, code: string, message: string, requestId: string, issues?: Array<{ path: Array<string | number>; message: string }>): void {
  response.status(status).json({ code, message, requestId, ...(issues?.length ? { issues } : {}) });
}

function mappedError(error: unknown): { status: 400 | 401 | 403 | 404 | 409 | 429 | 503 | 500; code: string; message: string; issues?: Array<{ path: Array<string | number>; message: string }> } {
  if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) };
  if (error instanceof ZodError) return { status: 400, code: "BAD_REQUEST", message: "request validation failed", issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) };
  // Never return database/stack/provider messages to a browser.  The caller
  // receives a stable error contract while the process logger can retain the
  // internal diagnostic in a deployment-specific error boundary.
  return { status: 500, code: "INTERNAL", message: "request failed" };
}

function requestId(request: Request): string {
  const provided = request.header("x-request-id");
  return provided && /^[A-Za-z0-9_-]{8,128}$/.test(provided) ? provided : randomBytes(12).toString("hex");
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.header("cookie");
  if (!header) return undefined;
  const pair = header.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return pair?.slice(name.length + 1);
}

function tokenHash(token: string, secret: string): string {
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

export function guestCookieHeader(name: string, token: string, secure: boolean): string {
  return [`${name}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=31536000", ...(secure ? ["Secure"] : [])].join("; ");
}

async function resolveGuest(request: Request, response: Response, options: ApiOptions) {
  const raw = cookieValue(request, options.guestCookieName);
  const suppliedToken = raw && /^[A-Za-z0-9_-]{32,256}$/.test(raw) ? raw : undefined;
  const hash = suppliedToken ? tokenHash(suppliedToken, options.guestCookieHashSecret) : "";
  const now = new Date();
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const existing = await options.prisma.guestSession.findUnique({ where: { tokenHash: hash } });
  // Rotate long-lived guest tokens without merging histories. The old row is
  // retained for audit/completion lookup but can no longer authenticate.
  const shouldRotate = Boolean(existing && !existing.revokedAt && existing.expiresAt > now && existing.createdAt.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const replacementToken = suppliedToken && existing && !shouldRotate && !existing.revokedAt && existing.expiresAt > now
    ? suppliedToken
    : randomBytes(32).toString("base64url");
  const guest = existing && !shouldRotate
    ? (existing.revokedAt || existing.expiresAt <= now
      ? await options.prisma.$transaction(async (tx) => {
        await tx.guestSession.update({ where: { id: existing.id }, data: { revokedAt: now, lastSeenAt: now } });
        return tx.guestSession.create({ data: { tokenHash: tokenHash(replacementToken, options.guestCookieHashSecret), expiresAt: expires, rotationOfId: existing.id } });
      })
      : await options.prisma.guestSession.update({ where: { id: existing.id }, data: { lastSeenAt: now } }))
    : await options.prisma.$transaction(async (tx) => {
      if (existing) await tx.guestSession.update({ where: { id: existing.id }, data: { revokedAt: now, lastSeenAt: now } });
      return tx.guestSession.create({ data: { tokenHash: tokenHash(replacementToken, options.guestCookieHashSecret), expiresAt: expires, ...(existing?.id ? { rotationOfId: existing.id } : {}) } });
    });
  const needsCookie = replacementToken !== suppliedToken;
  if (needsCookie) {
    response.setHeader("Set-Cookie", guestCookieHeader(options.guestCookieName, replacementToken, options.secureCookies));
  }
  return guest;
}

/**
 * Read-only guest lookup used by list endpoints.  We intentionally do not
 * create a guest session merely because somebody browsed the archive; a
 * completion hint is included only when an existing, unrevoked cookie is
 * recognized.  That keeps anonymous GETs cache-friendly and avoids writing
 * to the database on every page view.
 */
async function completionMap(request: Request, options: ApiOptions, spotVersionIds: string[]): Promise<Map<string, boolean> | undefined> {
  if (!spotVersionIds.length) return undefined;
  const raw = cookieValue(request, options.guestCookieName);
  if (!raw || !/^[A-Za-z0-9_-]{32,256}$/.test(raw)) return undefined;
  const guest = await options.prisma.guestSession.findUnique({ where: { tokenHash: tokenHash(raw, options.guestCookieHashSecret) } });
  if (!guest || guest.revokedAt || guest.expiresAt <= new Date()) return undefined;
  const attempts = await options.prisma.attempt.findMany({
    where: { guestSessionId: guest.id, spotVersionId: { in: spotVersionIds } },
    select: { spotVersionId: true },
    distinct: ["spotVersionId"],
  });
  const completed = new Set(attempts.map((attempt) => attempt.spotVersionId));
  return new Map(spotVersionIds.map((id) => [id, completed.has(id)]));
}

function toPublicSpot(spot: { versions: Array<{ publicPayload: unknown }> }): PublicSpot {
  const payload = spot.versions[0]?.publicPayload;
  if (!payload) throw new Error("published spot has no public payload");
  return publicSpotSchema.parse(payload);
}

function summaryFromPayload(payload: unknown, slotOrder: number, title: string, completed?: boolean) {
  const parsed = publicSpotSchema.parse(payload);
  return { spotId: parsed.spotId, spotVersionId: parsed.spotVersionId, publicationDate: parsed.publicationDate, slotOrder, title, ...(completed === undefined ? {} : { completed }) };
}

function etag(payload: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
}

export function createPublicApiRouter(options: ApiOptions): Router {
  const router = express.Router();
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  router.use((request, response, next) => {
    options.metrics?.increment("api.requests");
    const id = requestId(request);
    request.headers["x-request-id"] = id;
    response.setHeader("X-Request-ID", id);
    if (request.method === "POST" && request.path.endsWith("/attempts")) {
      const now = Date.now();
      const key = request.ip || "unknown";
      const prior = requestCounts.get(key);
      const entry = !prior || prior.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : prior;
      entry.count += 1;
      requestCounts.set(key, entry);
      if (entry.count > 60) {
        options.metrics?.increment("api.rate_limited");
        response.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
        return errorResponse(response, 429, "RATE_LIMITED", "too many attempt submissions", id);
      }
      if (requestCounts.size > 10_000) {
        for (const [address, value] of requestCounts) if (value.resetAt <= now) requestCounts.delete(address);
      }
    }
    return next();
  });
  router.use(express.json({ limit: "128kb" }));

  router.get("/auth/me", async (request, response) => {
    const id = requestId(request);
    try {
      if (!options.identityProvider) return errorResponse(response, 401, "UNAUTHENTICATED", "account authentication is not configured", id);
      const principal = await requirePrincipal(options.identityProvider, request);
      const account = await options.prisma.account.upsert({ where: { subject: principal.subject }, create: { subject: principal.subject, email: principal.email ?? null, roles: principal.roles }, update: { email: principal.email ?? null, roles: principal.roles } });
      return response.json({ subject: principal.subject, email: account.email, roles: principal.roles, accountId: account.id });
    } catch (error) { const mapped = mappedError(error); return errorResponse(response, mapped.status, mapped.code, mapped.message, id, mapped.issues); }
  });

  router.get("/auth/history", async (request, response) => {
    const id = requestId(request);
    try {
      if (!options.identityProvider) return errorResponse(response, 401, "UNAUTHENTICATED", "account authentication is not configured", id);
      const principal = await requirePrincipal(options.identityProvider, request);
      const account = await options.prisma.account.findUnique({ where: { subject: principal.subject }, select: { id: true } });
      if (!account) return response.json({ attempts: [] });
      const attempts = await options.prisma.attempt.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, spotId: true, spotVersionId: true, official: true, practiceOrdinal: true, overallSimilarity: true, createdAt: true } });
      return response.json({ attempts });
    } catch (error) { const mapped = mappedError(error); return errorResponse(response, mapped.status, mapped.code, mapped.message, id, mapped.issues); }
  });

  router.get("/spots/today", async (request, response) => {
    const id = requestId(request);
    try {
      const today = pacificDate();
      let slots = await options.prisma.publicationSlot.findMany({ where: { publicationDate: new Date(`${today}T00:00:00.000Z`), status: PublicationSlotStatus.PUBLISHED }, include: { spotVersion: { include: { spot: true } } }, orderBy: { slotOrder: "asc" } });
      let isFallback = false;
      let fallbackFromDate: string | undefined;
      if (!slots.length) {
        const latest = await options.prisma.publicationSlot.findFirst({ where: { status: PublicationSlotStatus.PUBLISHED, publicationDate: { lt: new Date(`${today}T00:00:00.000Z`) } }, orderBy: [{ publicationDate: "desc" }, { slotOrder: "asc" }] });
        if (latest) {
          fallbackFromDate = latest.publicationDate.toISOString().slice(0, 10);
          slots = await options.prisma.publicationSlot.findMany({ where: { status: PublicationSlotStatus.PUBLISHED, publicationDate: latest.publicationDate }, include: { spotVersion: { include: { spot: true } } }, orderBy: { slotOrder: "asc" } });
          isFallback = true;
          console.warn(`daily spot fallback: no published slots for ${today}; serving ${fallbackFromDate}`);
          options.metrics?.increment("publication.fallback");
        }
      }
      const completions = await completionMap(request, options, slots.map((slot) => slot.spotVersionId));
      const data = todayResponseSchema.parse({ publicationDate: today, timezone: "America/Los_Angeles", isFallback, ...(fallbackFromDate ? { fallbackFromDate } : {}), spots: slots.map((slot) => summaryFromPayload(slot.spotVersion.publicPayload, slot.slotOrder, slot.spotVersion.spot.title, completions?.get(slot.spotVersionId))) });
      response.setHeader("ETag", etag(data));
      response.setHeader("Vary", "Origin, Cookie");
      response.setHeader("Cache-Control", completions ? "private, no-store" : (isFallback ? "public, max-age=15, stale-while-revalidate=30" : "public, max-age=30, stale-while-revalidate=60"));
      if (request.header("if-none-match") === response.getHeader("ETag")) return response.status(304).end();
      return response.json(data);
    } catch (error) {
      const mapped = mappedError(error); return errorResponse(response, mapped.status, mapped.code, mapped.message, id, mapped.issues);
    }
  });

  router.get("/spots/archive", async (request, response) => {
    const id = requestId(request);
    try {
      const limitRaw = Number(request.query.limit ?? 20);
      const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
      const cursor = typeof request.query.cursor === "string" ? Buffer.from(request.query.cursor, "base64url").toString("utf8").split("|") : undefined;
      const where = { status: PublicationSlotStatus.PUBLISHED, ...(cursor?.length === 2 ? { OR: [{ publicationDate: { lt: new Date(`${cursor[0]}T00:00:00.000Z`) } }, { publicationDate: new Date(`${cursor[0]}T00:00:00.000Z`), slotOrder: { gt: Number(cursor[1]) } }] } : {}) };
      const slots = await options.prisma.publicationSlot.findMany({ where, include: { spotVersion: { include: { spot: true } } }, orderBy: [{ publicationDate: "desc" }, { slotOrder: "asc" }], take: limit + 1 });
      const hasMore = slots.length > limit;
      const page = hasMore ? slots.slice(0, limit) : slots;
      const next = hasMore ? Buffer.from(`${page.at(-1)!.publicationDate.toISOString().slice(0, 10)}|${page.at(-1)!.slotOrder}`).toString("base64url") : undefined;
      const completions = await completionMap(request, options, page.map((slot) => slot.spotVersionId));
      const data = archiveResponseSchema.parse({ spots: page.map((slot) => summaryFromPayload(slot.spotVersion.publicPayload, slot.slotOrder, slot.spotVersion.spot.title, completions?.get(slot.spotVersionId))), ...(next ? { nextCursor: next } : {}) });
      const tag = etag(data);
      response.setHeader("ETag", tag);
      response.setHeader("Cache-Control", "private, max-age=30");
      if (request.header("if-none-match") === tag) return response.status(304).end();
      return response.json(data);
    } catch (error) {
      const mapped = mappedError(error); return errorResponse(response, mapped.status, mapped.code, mapped.message, id, mapped.issues);
    }
  });

  router.get("/spots/:spotId", async (request, response) => {
    const id = requestId(request);
    try {
      const spot = await options.prisma.spot.findFirst({ where: { id: request.params.spotId, versions: { some: { status: SpotVersionStatus.PUBLISHED } } }, include: { versions: { where: { status: SpotVersionStatus.PUBLISHED }, orderBy: { version: "desc" }, take: 1 } } });
      if (!spot) return errorResponse(response, 404, "SPOT_NOT_FOUND", "published spot not found", id);
      const payload = toPublicSpot(spot);
      const tag = etag(payload);
      response.setHeader("ETag", tag);
      if (request.header("if-none-match") === tag) return response.status(304).end();
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return response.json(payload);
    } catch (error) {
      const mapped = mappedError(error); return errorResponse(response, mapped.status, mapped.code, mapped.message, id, mapped.issues);
    }
  });

  router.post("/spots/:spotId/attempts", async (request, response) => {
    const id = requestId(request);
    try {
      const spot = await options.prisma.spot.findFirst({ where: { id: request.params.spotId, versions: { some: { status: SpotVersionStatus.PUBLISHED } } }, include: { versions: { where: { status: SpotVersionStatus.PUBLISHED }, orderBy: { version: "desc" }, take: 1 } } });
      if (!spot || !spot.versions[0]) return errorResponse(response, 404, "SPOT_NOT_FOUND", "published spot not found", id);
      const publicSpot = publicSpotSchema.parse(spot.versions[0].publicPayload);
      const requestBody = validateAttemptForSpot(publicSpot, request.body);
      const privatePayload = spot.versions[0].privateSolutionPayload as { actionOrder: string[]; byCombo: Record<string, { frequencies: Record<string, number> }> };
      const principal = options.identityProvider ? await options.identityProvider.verify(request) : null;
      const account = principal ? await options.prisma.account.upsert({ where: { subject: principal.subject }, create: { subject: principal.subject, email: principal.email ?? null, roles: principal.roles }, update: { email: principal.email ?? null, roles: principal.roles } }) : null;
      const guest = account ? null : await resolveGuest(request, response, options);
      const prior = guest
        ? await options.prisma.attempt.findUnique({ where: { guestSessionId_spotVersionId_idempotencyKey: { guestSessionId: guest.id, spotVersionId: publicSpot.spotVersionId, idempotencyKey: requestBody.idempotencyKey } } })
        : await options.prisma.attempt.findUnique({ where: { accountId_spotVersionId_idempotencyKey: { accountId: account!.id, spotVersionId: publicSpot.spotVersionId, idempotencyKey: requestBody.idempotencyKey } } });
      if (prior) return response.json(attemptResponseSchema.parse(prior.resultPayload));
      const resultHands = requestBody.hands.map((hand) => {
        const gto = privatePayload.byCombo[hand.combo]?.frequencies;
        if (!gto) throw new Error(`private strategy is missing for ${hand.combo}`);
        return { combo: hand.combo, ...scoreHands(privatePayload.actionOrder, hand.allocations, gto) };
      });
      // Allocate the ID before the transaction so the immutable result payload
      // and Attempt row are written atomically (there is no transient
      // "pending" attempt ID visible to an idempotent retry).
      const attemptId = randomBytes(16).toString("hex");
      const result = attemptResponseSchema.parse({ attemptId, official: false, metric: { key: "l1", version: 1 }, aggregator: { key: "equal_average", version: 1 }, overallSimilarity: resultHands.reduce((sum, hand) => sum + hand.similarity, 0) / resultHands.length, hands: resultHands });
      const saved = await options.prisma.$transaction(async (tx) => {
        const owner = guest ? { guestSessionId: guest.id } : { accountId: account!.id };
        const officialExists = await tx.attempt.findFirst({ where: { ...owner, spotVersionId: publicSpot.spotVersionId, official: true }, select: { id: true } });
        const official = !officialExists;
        const count = await tx.attempt.count({ where: { ...owner, spotVersionId: publicSpot.spotVersionId } });
        const finalResult = { ...result, official };
        const created = await tx.attempt.create({ data: { id: attemptId, ...(guest ? { guestSessionId: guest.id } : { accountId: account!.id }), spotId: spot.id, spotVersionId: publicSpot.spotVersionId, official, practiceOrdinal: official ? 0 : count, idempotencyKey: requestBody.idempotencyKey, submittedPayload: requestBody, resultPayload: finalResult, overallSimilarity: result.overallSimilarity, metricKey: "l1", metricVersion: 1, aggregatorKey: "equal_average", aggregatorVersion: 1, requestMetadata: { requestId: id } } });
        return { created, official };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return response.status(201).json(attemptResponseSchema.parse({ ...result, official: saved.official }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return errorResponse(response, 409, "ATTEMPT_CONFLICT", "an official attempt or idempotency key already exists", id);
      const mapped = mappedError(error); return errorResponse(response, mapped.status === 500 ? 400 : mapped.status, mapped.status === 500 ? "ATTEMPT_REJECTED" : mapped.code, mapped.message, id, mapped.issues);
    }
  });
  return router;
}
