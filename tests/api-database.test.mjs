import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import pg from "pg";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { createPublicApiRouter } from "../dist/api.js";
import { pacificDate, addPacificDays } from "../dist/publication.js";
import { payloadSha256 } from "../dist/solver/normalized.js";
import { PublicApplicationService } from "../dist/application/public-api.js";

const databaseUrl = process.env.DATABASE_URL;

test("public API serves immutable public spots and scores one official then practice attempts", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `api_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = { template: `${suffix}_template`, job: `${suffix}_job`, run: `${suffix}_run`, spot: `${suffix}_spot`, version: `${suffix}_version` };
  const publicationDate = addPacificDays(pacificDate(), -1);
  const sourceHash = "d".repeat(64);
  const publicPayload = {
    schemaVersion: 3, spotId: ids.spot, spotVersionId: ids.version, publicationDate, slotOrder: 1,
    preflop: { status: "known", scenarioId: "2bet_call", label: "BTN opens, BB calls", summary: "Single-raised pot.", actions: [{ sequence: 1, actor: "ip", position: "BTN", type: "open", amountBb: 2.5, label: "BTN opens to 2.5 bb" }, { sequence: 2, actor: "oop", position: "BB", type: "call", amountBb: 2.5, label: "BB calls" }], rangeAssumptions: { ip: { presetId: "open_ip", label: "IP opening range", cells: [{ handClass: "AA", inclusionBasisPoints: 10000 }] }, oop: { presetId: "call_oop", label: "OOP calling range", cells: [{ handClass: "KQs", inclusionBasisPoints: 7500 }] } } },
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } }, history: [{ kind: "decision", actor: "oop" }],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    legalActions: [{ id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false }, { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", solverLabel: "BET 25.000000", isAllIn: false }], featuredCombo: "AhAs", selectableCombos: [{ combo: "AhAs", category: "pair" }], presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
  const privatePayload = { schemaVersion: 1, actionOrder: ["a0", "a1"], byCombo: { AhAs: { reachWeight: 1, frequencies: { a0: 2_500, a1: 7_500 } } }, reachedRanges: { hero: { AhAs: 1 }, opponent: { KcKd: 1 } } };
  let server;
  try {
    await prisma.solverTemplate.create({ data: { id: ids.template, familyId: suffix, version: 1, name: "API test", config: { pot: 50, effective_stack: 100, board: ["Qs", "Jh", "2h"], ranges: { ip: "AA", oop: "KK" } }, updatedAt: new Date() } });
    await prisma.solverJob.create({ data: { id: ids.job, templateId: ids.template, effectiveSeed: suffix, updatedAt: new Date() } });
    await prisma.solverRun.create({ data: { id: ids.run, jobId: ids.job, attemptNumber: 1, status: "SUCCEEDED", resolvedInput: {}, sourceHash, outputSha256: `${suffix}_output` } });
    await prisma.spot.create({ data: { id: ids.spot, title: "API test spot", status: "PUBLISHED", updatedAt: new Date() } });
    await prisma.spotVersion.create({ data: { id: ids.version, spotId: ids.spot, version: 1, solverRunId: ids.run, candidateManifest: { sourceHash, path: ["root"], rankingVersion: "1", fallbackUsed: false }, publicPayload, privateSolutionPayload: privatePayload, normalizerVersion: "1", selectionRankingVersion: "1", publicPayloadSha256: payloadSha256(publicPayload), privatePayloadSha256: payloadSha256(privatePayload), status: "PUBLISHED", validatedAt: new Date(), publishedAt: new Date() } });
    await prisma.publicationSlot.create({ data: { id: `${suffix}_slot`, publicationDate: new Date(`${publicationDate}T00:00:00.000Z`), slotOrder: 1, spotVersionId: ids.version, status: "PUBLISHED", publishedAt: new Date(), updatedAt: new Date() } });

    const app = express();
    app.use("/api/v1", createPublicApiRouter({ application: new PublicApplicationService(prisma), prisma, guestCookieHashSecret: "integration-test-secret", guestCookieName: "integration_guest", secureCookies: false }));
    server = createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const spotResponse = await fetch(`${base}/api/v1/spots/${ids.spot}`);
    assert.equal(spotResponse.status, 200);
    const spotBody = await spotResponse.json();
    assert.equal(spotBody.spotId, ids.spot);
    const forbiddenKeys = new Set(["privateSolutionPayload", "frequencies", "reachedRanges", "reachWeight", "actionOrder", "gto", "solution"]);
    const assertNoPrivateFields = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbiddenKeys.has(key), false, `private field leaked: ${key}`);
        assertNoPrivateFields(child);
      }
    };
    assertNoPrivateFields(spotBody);
    const etag = spotResponse.headers.get("etag");
    assert.ok(etag);
    assert.equal((await fetch(`${base}/api/v1/spots/${ids.spot}`, { headers: { "if-none-match": etag } })).status, 304);

    const today = await fetch(`${base}/api/v1/daily-games/today`);
    const todayBody = await today.json();
    assert.equal(today.status, 200);
    assert.equal(todayBody.fallback.active, true);
    assert.equal(todayBody.date, publicationDate);
    assert.match(today.headers.get("cache-control") ?? "", /private/);
    assert.match(today.headers.get("vary") ?? "", /Cookie/);

    const request = { spotVersionId: ids.version, hands: [{ combo: "AhAs", allocations: { a0: 5_000, a1: 5_000 } }] };
    const firstKey = `${suffix}_idempotency_1`;
    const first = await fetch(`${base}/api/v1/spots/${ids.spot}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": firstKey }, body: JSON.stringify(request) });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.attemptKind, "official");
    assert.equal(firstBody.score.points, 750);
    assert.equal(first.headers.get("location"), `/api/v1/attempts/${firstBody.attemptId}`);
    assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly/);
    const cookie = first.headers.get("set-cookie")?.split(";", 1)[0];
    const retry = await fetch(`${base}/api/v1/spots/${ids.spot}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": firstKey, cookie }, body: JSON.stringify(request) });
    assert.equal(retry.status, 201);
    assert.equal((await retry.json()).attemptId, firstBody.attemptId);
    const practice = await fetch(`${base}/api/v1/spots/${ids.spot}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `${suffix}_idempotency_2`, cookie }, body: JSON.stringify(request) });
    assert.equal(practice.status, 201);
    assert.equal((await practice.json()).attemptKind, "practice");
    assert.equal(await prisma.attempt.count({ where: { spotVersionId: ids.version } }), 2);
    const result = await fetch(`${base}/api/v1/attempts/${firstBody.attemptId}`, { headers: { cookie } });
    assert.equal(result.status, 200);
    const resultBody = await result.json();
    assert.equal(resultBody.hands[0].actions[0].gtoBasisPoints, 2500);
    assert.equal(resultBody.attemptKind, "official");

    const archive = await fetch(`${base}/api/v1/daily-games?from=${publicationDate}&to=${publicationDate}`, { headers: { cookie } });
    assert.equal(archive.status, 200);
    assert.match(archive.headers.get("cache-control") ?? "", /private/);
    const archiveBody = await archive.json();
    assert.equal(archiveBody.games[0].completedSpots, 1);
    const completedToday = await fetch(`${base}/api/v1/daily-games/today`, { headers: { cookie } });
    const completedTodayBody = await completedToday.json();
    assert.equal(completedTodayBody.spots.find((spot) => spot.spotVersionId === ids.version)?.completed, true);
    const stats = await fetch(`${base}/api/v1/users/me/stats`, { headers: { cookie } });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).spotsCompleted, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const owners = await prisma.attempt.findMany({ where: { spotVersionId: ids.version }, select: { guestSessionId: true, guestIdentityId: true } });
    const guestIds = owners.map((attempt) => attempt.guestSessionId).filter(Boolean);
    const identityIds = owners.map((attempt) => attempt.guestIdentityId).filter(Boolean);
    await prisma.attempt.deleteMany({ where: { spotVersionId: ids.version } });
    if (guestIds.length) await prisma.guestSession.deleteMany({ where: { id: { in: guestIds } } });
    if (identityIds.length) await prisma.guestIdentity.deleteMany({ where: { id: { in: identityIds } } });
    await prisma.publicationSlot.deleteMany({ where: { spotVersionId: ids.version } });
    await prisma.spotVersion.deleteMany({ where: { id: ids.version } });
    await prisma.spot.deleteMany({ where: { id: ids.spot } });
    await prisma.solverRun.deleteMany({ where: { id: ids.run } });
    await prisma.solverJob.deleteMany({ where: { id: ids.job } });
    await prisma.solverTemplate.deleteMany({ where: { id: ids.template } });
    await prisma.$disconnect();
  }
});
