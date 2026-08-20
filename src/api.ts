import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { Prisma, PublicationSlotStatus, SpotVersionStatus, type PrismaClient } from "@prisma/client";
import { archiveResponseSchema, attemptResponseSchema, publicSpotSchema, todayResponseSchema, validateAttemptForSpot, type PublicSpot } from "@poker-trainer/contracts";
import { pacificDate } from "./publication.js";
import { scoreHands } from "./scoring.js";

type ApiOptions = {
  prisma: PrismaClient;
  guestCookieHashSecret: string;
  guestCookieName: string;
  secureCookies: boolean;
};

function errorResponse(response: Response, status: number, code: string, message: string, requestId: string): void {
  response.status(status).json({ code, message, requestId });
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

async function resolveGuest(request: Request, response: Response, options: ApiOptions) {
  const raw = cookieValue(request, options.guestCookieName);
  const token = raw && /^[A-Za-z0-9_-]{32,256}$/.test(raw) ? raw : randomBytes(32).toString("base64url");
  const hash = tokenHash(token, options.guestCookieHashSecret);
  const now = new Date();
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const existing = await options.prisma.guestSession.findUnique({ where: { tokenHash: hash } });
  const guest = existing
    ? await options.prisma.guestSession.update({ where: { id: existing.id }, data: { lastSeenAt: now } })
    : await options.prisma.guestSession.create({ data: { tokenHash: hash, expiresAt: expires } });
  if (!raw || !existing) {
    const flags = [`${options.guestCookieName}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=31536000"];
    if (options.secureCookies) flags.push("Secure");
    response.setHeader("Set-Cookie", flags.join("; "));
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
  return { spotId: parsed.spotId, spotVersionId: parsed.spotVersionId, mode: parsed.mode, publicationDate: parsed.publicationDate, slotOrder, title, ...(completed === undefined ? {} : { completed }) };
}

function etag(payload: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
}

export function createPublicApiRouter(options: ApiOptions): Router {
  const router = express.Router();
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  router.use((request, response, next) => {
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
        }
      }
      const completions = await completionMap(request, options, slots.map((slot) => slot.spotVersionId));
      const data = todayResponseSchema.parse({ publicationDate: today, timezone: "America/Los_Angeles", isFallback, ...(fallbackFromDate ? { fallbackFromDate } : {}), spots: slots.map((slot) => summaryFromPayload(slot.spotVersion.publicPayload, slot.slotOrder, slot.spotVersion.spot.title, completions?.get(slot.spotVersionId))) });
      response.setHeader("ETag", etag(data));
      if (request.header("if-none-match") === response.getHeader("ETag")) return response.status(304).end();
      return response.json(data);
    } catch (error) {
      return errorResponse(response, 500, "TODAY_READ_FAILED", error instanceof Error ? error.message : "today read failed", id);
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
      return errorResponse(response, 500, "ARCHIVE_READ_FAILED", error instanceof Error ? error.message : "archive read failed", id);
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
      return errorResponse(response, 500, "SPOT_READ_FAILED", error instanceof Error ? error.message : "spot read failed", id);
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
      const guest = await resolveGuest(request, response, options);
      const prior = await options.prisma.attempt.findUnique({ where: { guestSessionId_spotVersionId_idempotencyKey: { guestSessionId: guest.id, spotVersionId: publicSpot.spotVersionId, idempotencyKey: requestBody.idempotencyKey } } });
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
        const officialExists = await tx.attempt.findFirst({ where: { guestSessionId: guest.id, spotVersionId: publicSpot.spotVersionId, official: true }, select: { id: true } });
        const official = !officialExists;
        const count = await tx.attempt.count({ where: { guestSessionId: guest.id, spotVersionId: publicSpot.spotVersionId } });
        const finalResult = { ...result, official };
        const created = await tx.attempt.create({ data: { id: attemptId, guestSessionId: guest.id, spotId: spot.id, spotVersionId: publicSpot.spotVersionId, official, practiceOrdinal: official ? 0 : count, idempotencyKey: requestBody.idempotencyKey, submittedPayload: requestBody, resultPayload: finalResult, overallSimilarity: result.overallSimilarity, metricKey: "l1", metricVersion: 1, aggregatorKey: "equal_average", aggregatorVersion: 1, requestMetadata: { requestId: id } } });
        return { created, official };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return response.status(201).json(attemptResponseSchema.parse({ ...result, official: saved.official }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return errorResponse(response, 409, "ATTEMPT_CONFLICT", "an official attempt or idempotency key already exists", id);
      return errorResponse(response, 400, "ATTEMPT_REJECTED", error instanceof Error ? error.message : "attempt rejected", id);
    }
  });
  return router;
}
