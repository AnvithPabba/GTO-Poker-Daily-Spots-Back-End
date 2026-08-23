import { createHash, randomBytes } from "node:crypto";
import { Prisma, PublicationSlotStatus, SpotVersionStatus, type PrismaClient } from "@prisma/client";
import {
  AttemptContractError,
  attemptHistoryResponseSchema,
  attemptResourceSchema,
  createAttemptResponseSchema,
  dailyGameRangeResponseSchema,
  dailyGameSchema,
  publicSpotSchema,
  statsResponseSchema,
  validateAttemptForSpot,
  type AttemptResource,
  type CreateAttemptRequest,
  type DailyGame,
  type PublicSpot,
} from "@poker-trainer/contracts";
import { AppError } from "../errors.js";
import type { Clock } from "../ports.js";
import { SystemClock } from "../ports.js";
import { addPacificDays, pacificDate } from "../publication.js";
import { scoreHands } from "../scoring.js";

export type Visitor =
  | { kind: "guest"; identityId: string; sessionId: string }
  | { kind: "account"; accountId: string };

type PrivateSolution = { actionOrder: string[]; byCombo: Record<string, { frequencies: Record<string, number> }> };

/**
 * Resolve one exact two-card holding from the immutable private solution.
 *
 * Solver providers can serialize the same holding in either card order.  The
 * resolver therefore checks only the submitted canonical spelling and its
 * reversed spelling.  It deliberately has no featured-hand or first-entry
 * fallback: scoring a different holding would silently corrupt a result.
 */
export function resolveExactComboStrategy(
  solution: PrivateSolution,
  combo: string,
): { frequencies: Record<string, number> } | undefined {
  const direct = solution.byCombo[combo];
  if (direct) return direct;
  const reversed = `${combo.slice(2)}${combo.slice(0, 2)}`;
  return solution.byCombo[reversed];
}

function ownerWhere(visitor: Visitor) {
  return visitor.kind === "guest" ? { guestIdentityId: visitor.identityId } : { accountId: visitor.accountId };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function dateValue(date: string): Date { return new Date(`${date}T00:00:00.000Z`); }
function dateText(value: Date): string { return value.toISOString().slice(0, 10); }

export function readPublicSpot(payload: unknown): PublicSpot {
  if (payload && typeof payload === "object" && (payload as { schemaVersion?: unknown }).schemaVersion === 2) {
    return publicSpotSchema.parse({
      ...(payload as Record<string, unknown>),
      schemaVersion: 3,
      preflop: { status: "unknown", label: "Preflop start unavailable", summary: "This legacy solve did not preserve its preflop scenario." },
    });
  }
  return publicSpotSchema.parse(payload);
}

function scoreFromSimilarity(similarityBasisPoints: number) {
  return { points: Math.round(similarityBasisPoints / 10), maximumPoints: 1_000 as const, similarityBasisPoints };
}

type BreakdownSample = { key: string; label: string; similarityBasisPoints: number };
export function summarizeBreakdowns(samples: BreakdownSample[]) {
  const groups = new Map<string, { key: string; label: string; scores: number[] }>();
  for (const sample of samples) {
    const group = groups.get(sample.key) ?? { key: sample.key, label: sample.label, scores: [] };
    group.scores.push(sample.similarityBasisPoints);
    groups.set(sample.key, group);
  }
  return [...groups.values()]
    .filter((group) => group.scores.length >= 3)
    .map((group) => ({
      key: group.key,
      label: group.label,
      sampleSize: group.scores.length,
      averageScoreBasisPoints: Math.round(group.scores.reduce((sum, score) => sum + score, 0) / group.scores.length),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export class PublicApplicationService {
  public constructor(private readonly prisma: PrismaClient, private readonly clock: Clock = new SystemClock()) {}

  private async slotsFor(date: string) {
    return this.prisma.publicationSlot.findMany({
      where: { publicationDate: dateValue(date), status: PublicationSlotStatus.PUBLISHED },
      include: { spotVersion: { include: { spot: true } } },
      orderBy: { slotOrder: "asc" },
    });
  }

  private async progressFor(date: string, visitor: Visitor, slots = undefined as Awaited<ReturnType<PublicApplicationService["slotsFor"]>> | undefined) {
    const published = slots ?? await this.slotsFor(date);
    const versionIds = published.map((slot) => slot.spotVersionId);
    const attempts = versionIds.length ? await this.prisma.attempt.findMany({
      where: { ...ownerWhere(visitor), official: true, validity: "VALID", spotVersionId: { in: versionIds } },
      select: { spotVersionId: true, scorePoints: true },
    }) : [];
    const byVersion = new Map(attempts.map((attempt) => [attempt.spotVersionId, attempt]));
    const completedSpots = byVersion.size;
    const totalSpots = published.length;
    const next = published.find((slot) => !byVersion.has(slot.spotVersionId));
    return {
      completedSpots,
      totalSpots,
      status: completedSpots === 0 ? "not_started" as const : completedSpots === totalSpots ? "completed" as const : "in_progress" as const,
      nextSpot: next ? { id: next.spotVersion.spotId, sequence: next.slotOrder } : null,
      scorePoints: attempts.reduce((sum, attempt) => sum + attempt.scorePoints, 0),
      maximumScorePoints: totalSpots * 1_000,
    };
  }

  public async getDailyGame(requestedDate: string, visitor: Visitor, allowFallback: boolean): Promise<DailyGame> {
    let servedDate = requestedDate;
    let slots = await this.slotsFor(servedDate);
    let fallbackReason: string | undefined;
    if (!slots.length && allowFallback) {
      const latest = await this.prisma.publicationSlot.findFirst({
        where: { publicationDate: { lt: dateValue(requestedDate) }, status: PublicationSlotStatus.PUBLISHED },
        orderBy: [{ publicationDate: "desc" }, { slotOrder: "asc" }],
      });
      if (latest) {
        servedDate = dateText(latest.publicationDate);
        slots = await this.slotsFor(servedDate);
        fallbackReason = `No published daily game for ${requestedDate}; serving ${servedDate}.`;
      }
    }
    if (!slots.length) throw new AppError("SPOT_NOT_AVAILABLE", "daily game is not available", 404, { requestedDate });
    const progress = await this.progressFor(servedDate, visitor, slots);
    const completed = new Map((await this.prisma.attempt.findMany({
      where: { ...ownerWhere(visitor), official: true, validity: "VALID", spotVersionId: { in: slots.map((slot) => slot.spotVersionId) } },
      select: { spotVersionId: true, scorePoints: true },
    })).map((attempt) => [attempt.spotVersionId, attempt.scorePoints]));
    return dailyGameSchema.parse({
      date: servedDate,
      requestedDate,
      timezone: "America/Los_Angeles",
      fallback: { active: Boolean(fallbackReason), ...(fallbackReason ? { reason: fallbackReason } : {}) },
      spots: slots.map((slot) => {
        const spot = readPublicSpot(slot.spotVersion.publicPayload);
        return {
          spotId: spot.spotId,
          spotVersionId: spot.spotVersionId,
          sequence: slot.slotOrder,
          title: slot.spotVersion.spot.title,
          street: spot.decision.street,
          heroPosition: spot.presentation.positions[spot.presentation.heroActor],
          completed: completed.has(slot.spotVersionId),
          ...(completed.has(slot.spotVersionId) ? { officialScorePoints: completed.get(slot.spotVersionId) } : {}),
        };
      }),
      progress,
    });
  }

  public async getDailyGameRange(from: string, to: string, visitor: Visitor) {
    if (dateValue(from) > dateValue(to) || dateValue(to).getTime() - dateValue(from).getTime() > 93 * 86_400_000) throw new AppError("BAD_REQUEST", "date range must be ordered and at most 93 days", 400);
    const slots = await this.prisma.publicationSlot.findMany({
      where: { publicationDate: { gte: dateValue(from), lte: dateValue(to) }, status: PublicationSlotStatus.PUBLISHED },
      orderBy: [{ publicationDate: "asc" }, { slotOrder: "asc" }],
    });
    const attempts = slots.length ? await this.prisma.attempt.findMany({
      where: { ...ownerWhere(visitor), official: true, validity: "VALID", spotVersionId: { in: slots.map((slot) => slot.spotVersionId) } },
      select: { spotVersionId: true, scorePoints: true },
    }) : [];
    const byVersion = new Map(attempts.map((attempt) => [attempt.spotVersionId, attempt.scorePoints]));
    const byDate = new Map<string, typeof slots>();
    for (const slot of slots) byDate.set(dateText(slot.publicationDate), [...(byDate.get(dateText(slot.publicationDate)) ?? []), slot]);
    return dailyGameRangeResponseSchema.parse({ from, to, games: [...byDate].map(([date, gameSlots]) => {
      const completedSpots = gameSlots.filter((slot) => byVersion.has(slot.spotVersionId)).length;
      return { date, spotCount: gameSlots.length, completedSpots, status: completedSpots === gameSlots.length ? "completed" : "available", officialScorePoints: gameSlots.reduce((sum, slot) => sum + (byVersion.get(slot.spotVersionId) ?? 0), 0), maximumScorePoints: gameSlots.length * 1_000 };
    }) });
  }

  public async getSpot(spotId: string): Promise<PublicSpot> {
    const spot = await this.prisma.spot.findFirst({
      where: { id: spotId, versions: { some: { status: SpotVersionStatus.PUBLISHED } } },
      include: { versions: { where: { status: SpotVersionStatus.PUBLISHED }, orderBy: { version: "desc" }, take: 1 } },
    });
    if (!spot?.versions[0]) throw new AppError("SPOT_NOT_FOUND", "published spot not found", 404);
    return readPublicSpot(spot.versions[0].publicPayload);
  }

  public async createAttempt(spotId: string, raw: unknown, idempotencyKey: string, visitor: Visitor) {
    if (!/^[A-Za-z0-9._:-]{16,256}$/.test(idempotencyKey)) throw new AppError("BAD_REQUEST", "Idempotency-Key must contain 16-256 safe characters", 400);
    const spotRecord = await this.prisma.spot.findFirst({
      where: { id: spotId, versions: { some: { status: SpotVersionStatus.PUBLISHED } } },
      include: { versions: { where: { status: SpotVersionStatus.PUBLISHED }, orderBy: { version: "desc" }, take: 1 } },
    });
    if (!spotRecord?.versions[0]) throw new AppError("SPOT_NOT_FOUND", "published spot not found", 404);
    const version = spotRecord.versions[0];
    const publicSpot = readPublicSpot(version.publicPayload);
    let request: CreateAttemptRequest;
    try { request = validateAttemptForSpot(publicSpot, raw); }
    catch (error) {
      if (error instanceof AttemptContractError) throw new AppError(error.code, error.message, 400, error.details);
      throw error;
    }
    const hash = payloadHash(request);
    const prior = await this.prisma.attempt.findFirst({ where: { ...ownerWhere(visitor), spotVersionId: request.spotVersionId, idempotencyKey } });
    if (prior) {
      if (prior.idempotencyPayloadHash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different attempt", 409);
      return this.toCreateResponse(prior, visitor);
    }
    const solution = version.privateSolutionPayload as unknown as PrivateSolution;
    const hands = request.hands.map((hand) => {
      const frequencies = resolveExactComboStrategy(solution, hand.combo)?.frequencies;
      if (!frequencies) throw new AppError("HAND_NOT_ALLOWED", "solution is unavailable for submitted hand", 400, { combo: hand.combo });
      const scored = scoreHands(solution.actionOrder, hand.allocations, frequencies);
      return { ...scored, combo: hand.combo, similarityBasisPoints: Math.round(scored.similarity * 100) };
    }).map(({ similarity: _similarity, ...hand }) => hand);
    const similarityBasisPoints = Math.round(hands.reduce((sum, hand) => sum + hand.similarityBasisPoints, 0) / hands.length);
    const attemptId = randomBytes(16).toString("hex");
    const coreResult = { metric: { key: "l1", version: 1 }, aggregator: { key: "equal_average", version: 1 }, score: scoreFromSimilarity(similarityBasisPoints), hands };
    const attemptData = {
      id: attemptId,
      ...(visitor.kind === "guest" ? { guestIdentityId: visitor.identityId, guestSessionId: visitor.sessionId } : { accountId: visitor.accountId }),
      spotId, spotVersionId: request.spotVersionId,
      idempotencyKey, idempotencyPayloadHash: hash,
      submittedPayload: request as Prisma.InputJsonValue, resultPayload: coreResult as Prisma.InputJsonValue,
      overallSimilarity: similarityBasisPoints / 100, similarityBasisPoints, scorePoints: coreResult.score.points,
      metricKey: "l1", metricVersion: 1, aggregatorKey: "equal_average", aggregatorVersion: 1,
    };
    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const official = !(await tx.attempt.findFirst({ where: { ...ownerWhere(visitor), spotVersionId: request.spotVersionId, official: true }, select: { id: true } }));
        const count = await tx.attempt.count({ where: { ...ownerWhere(visitor), spotVersionId: request.spotVersionId } });
        return tx.attempt.create({ data: { ...attemptData, official, practiceOrdinal: official ? 0 : count } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.prisma.attempt.findFirst({ where: { ...ownerWhere(visitor), spotVersionId: request.spotVersionId, idempotencyKey } });
        if (raced) {
          if (raced.idempotencyPayloadHash === hash) return this.toCreateResponse(raced, visitor);
          throw new AppError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different attempt", 409);
        }
        // A different idempotency key may race for the single official slot.
        // Preserve both valid submissions: the winner is official and this one
        // becomes practice, exactly as it would in sequential processing.
        created = await this.prisma.$transaction(async (tx) => {
          const count = await tx.attempt.count({ where: { ...ownerWhere(visitor), spotVersionId: request.spotVersionId } });
          return tx.attempt.create({ data: { ...attemptData, official: false, practiceOrdinal: count } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } else {
        throw error;
      }
    }
    return this.toCreateResponse(created, visitor);
  }

  private async publicationDateFor(spotVersionId: string): Promise<string> {
    const slot = await this.prisma.publicationSlot.findFirst({ where: { spotVersionId, status: PublicationSlotStatus.PUBLISHED }, orderBy: { publicationDate: "desc" } });
    return slot ? dateText(slot.publicationDate) : pacificDate(this.clock.now());
  }

  private async toCreateResponse(attempt: { id: string; official: boolean; spotVersionId: string; scorePoints: number; similarityBasisPoints: number }, visitor: Visitor) {
    const date = await this.publicationDateFor(attempt.spotVersionId);
    return createAttemptResponseSchema.parse({ attemptId: attempt.id, attemptKind: attempt.official ? "official" : "practice", score: { points: attempt.scorePoints, maximumPoints: 1_000, similarityBasisPoints: attempt.similarityBasisPoints }, progress: await this.progressFor(date, visitor) });
  }

  public async getAttempt(attemptId: string, visitor: Visitor): Promise<AttemptResource> {
    const attempt = await this.prisma.attempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new AppError("ATTEMPT_NOT_FOUND", "attempt not found", 404);
    const owns = visitor.kind === "guest" ? attempt.guestIdentityId === visitor.identityId : attempt.accountId === visitor.accountId;
    if (!owns) throw new AppError("ATTEMPT_FORBIDDEN", "attempt belongs to another visitor", 403);
    if (attempt.validity === "INVALIDATED") {
      throw new AppError("ATTEMPT_INVALIDATED", "this result was invalidated because the published solver version was replaced", 410, {
        spotId: attempt.spotId,
        replacementSpotVersionId: attempt.replacementSpotVersionId,
        reason: attempt.invalidationReason,
      });
    }
    const core = attempt.resultPayload as unknown as Omit<AttemptResource, "attemptId" | "spotId" | "spotVersionId" | "createdAt" | "attemptKind" | "progress">;
    return attemptResourceSchema.parse({ ...core, attemptId: attempt.id, spotId: attempt.spotId, spotVersionId: attempt.spotVersionId, createdAt: attempt.createdAt.toISOString(), attemptKind: attempt.official ? "official" : "practice", progress: await this.progressFor(await this.publicationDateFor(attempt.spotVersionId), visitor) });
  }

  public async getAttemptHistory(visitor: Visitor, limit: number, cursor?: string) {
    const decoded = cursor ? Buffer.from(cursor, "base64url").toString("utf8").split("|") : undefined;
    const rows = await this.prisma.attempt.findMany({
      where: { ...ownerWhere(visitor), validity: "VALID", ...(decoded?.length === 2 ? { OR: [{ createdAt: { lt: new Date(decoded[0]!) } }, { createdAt: new Date(decoded[0]!), id: { lt: decoded[1]! } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;
    return attemptHistoryResponseSchema.parse({ attempts: page.map((attempt) => ({ attemptId: attempt.id, spotId: attempt.spotId, spotVersionId: attempt.spotVersionId, attemptKind: attempt.official ? "official" : "practice", score: { points: attempt.scorePoints, maximumPoints: 1_000, similarityBasisPoints: attempt.similarityBasisPoints }, createdAt: attempt.createdAt.toISOString() })), ...(last ? { nextCursor: Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") } : {}) });
  }

  public async getStats(visitor: Visitor) {
    const attempts = await this.prisma.attempt.findMany({
      where: { ...ownerWhere(visitor), official: true, validity: "VALID" },
      select: { spotVersionId: true, createdAt: true, similarityBasisPoints: true, spotVersion: { select: { publicPayload: true } } },
    });
    const slots = await this.prisma.publicationSlot.findMany({ where: { status: PublicationSlotStatus.PUBLISHED }, orderBy: { publicationDate: "asc" } });
    const attemptByVersion = new Map(attempts.map((attempt) => [attempt.spotVersionId, attempt]));
    const games = new Map<string, typeof slots>();
    for (const slot of slots) games.set(dateText(slot.publicationDate), [...(games.get(dateText(slot.publicationDate)) ?? []), slot]);
    const completedDates = [...games].filter(([date, gameSlots]) => gameSlots.length > 0 && gameSlots.every((slot) => {
      const attempt = attemptByVersion.get(slot.spotVersionId);
      return attempt && pacificDate(attempt.createdAt) === date;
    })).map(([date]) => date).sort();
    const completedSet = new Set(completedDates);
    let bestStreak = 0;
    let running = 0;
    let previous: string | undefined;
    for (const date of completedDates) {
      running = previous && addPacificDays(previous, 1) === date ? running + 1 : 1;
      bestStreak = Math.max(bestStreak, running);
      previous = date;
    }
    const today = pacificDate(this.clock.now());
    let cursor = completedSet.has(today) ? today : addPacificDays(today, -1);
    let currentStreak = 0;
    while (completedSet.has(cursor)) { currentStreak += 1; cursor = addPacificDays(cursor, -1); }
    const average = attempts.length ? Math.round(attempts.reduce((sum, attempt) => sum + attempt.similarityBasisPoints, 0) / attempts.length) : 0;
    const described = attempts.map((attempt) => ({ attempt, spot: readPublicSpot(attempt.spotVersion.publicPayload) }));
    return statsResponseSchema.parse({
      currentStreak,
      bestStreak,
      dailyGamesCompleted: completedDates.length,
      spotsCompleted: attempts.length,
      averageScoreBasisPoints: average,
      breakdowns: {
        scenarios: summarizeBreakdowns(described.map(({ attempt, spot }) => ({
          key: spot.preflop.status === "known" ? spot.preflop.scenarioId : "unknown",
          label: spot.preflop.label,
          similarityBasisPoints: attempt.similarityBasisPoints,
        }))),
        streets: summarizeBreakdowns(described.map(({ attempt, spot }) => ({
          key: spot.decision.street,
          label: `${spot.decision.street[0]!.toUpperCase()}${spot.decision.street.slice(1)}`,
          similarityBasisPoints: attempt.similarityBasisPoints,
        }))),
        positions: summarizeBreakdowns(described.map(({ attempt, spot }) => ({
          key: spot.presentation.heroActor,
          label: `${spot.presentation.positions[spot.presentation.heroActor]} (${spot.presentation.heroActor.toUpperCase()})`,
          similarityBasisPoints: attempt.similarityBasisPoints,
        }))),
      },
    });
  }
}
