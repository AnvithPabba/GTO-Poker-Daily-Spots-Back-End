import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const base = process.env.FULL_STACK_BASE ?? "http://127.0.0.1:3000";
const enabled = process.env.FULL_STACK === "1";

async function get(path) {
  const response = await fetch(`${base}${path}`);
  return { response, body: await response.json().catch(() => undefined) };
}

test("running Compose stack exposes liveness, readiness, API contract, and no answer fields", { skip: !enabled && "set FULL_STACK=1 to exercise a running Compose stack" }, async () => {
  const apiLive = await get("/health/live");
  const apiReady = await get("/health/ready");
  assert.equal(apiLive.response.status, 200);
  assert.equal(apiReady.response.status, 200);
  const today = await get("/api/v1/daily-games/today");
  assert.ok([200, 404].includes(today.response.status));
  if (today.response.status === 200) assert.equal(today.body.timezone, "America/Los_Angeles");
  if (today.response.status === 404) assert.equal(today.body.error.code, "SPOT_NOT_AVAILABLE");
  const serialized = JSON.stringify(today.body);
  assert.doesNotMatch(serialized, /privateSolutionPayload|gtoFrequencies|reachedRanges|reachWeight|frequencies/);
  const frontend = await fetch("http://127.0.0.1:4173/health/live");
  assert.equal(frontend.status, 200);
  const proxy = await fetch("http://127.0.0.1:4173/api/health/live");
  assert.equal(proxy.status, 200);
  const adminProxy = await fetch("http://127.0.0.1:4173/api/v1/admin/status");
  assert.equal(adminProxy.status, process.env.FULL_STACK_ADMIN === "1" ? 200 : 404);
});

test("Compose serves today → spot → official attempt → result → practice with stable ownership", { skip: (!enabled || !process.env.DATABASE_URL || process.env.FULL_STACK_FIXTURE !== "1") && "set FULL_STACK=1, FULL_STACK_FIXTURE=1, and DATABASE_URL after importing a real spot" }, async () => {
  // Arrange
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const createdAttemptIds = [];
  let foreignToken;
  try {
    const todayResponse = await fetch(`${base}/api/v1/daily-games/today`);
    const cookie = todayResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const today = await todayResponse.json();
    assert.equal(todayResponse.status, 200);
    assert.ok(cookie);
    assert.ok(today.spots.length > 0);
    const summary = today.spots[0];
    const spotResponse = await fetch(`${base}/api/v1/spots/${summary.spotId}`, { headers: { cookie } });
    const spot = await spotResponse.json();
    const actionIds = spot.legalActions.map((action) => action.id);
    const baseValue = Math.floor(10_000 / actionIds.length);
    const allocations = Object.fromEntries(actionIds.map((id, index) => [id, baseValue + (index === actionIds.length - 1 ? 10_000 - baseValue * actionIds.length : 0)]));
    const request = { spotVersionId: spot.spotVersionId, hands: [{ combo: spot.featuredCombo, allocations }] };
    const key = `full-stack-${Date.now()}-official`;

    // Act
    const officialResponse = await fetch(`${base}/api/v1/spots/${spot.spotId}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, cookie }, body: JSON.stringify(request) });
    const official = await officialResponse.json();
    createdAttemptIds.push(official.attemptId);
    const resultResponse = await fetch(`${base}/api/v1/attempts/${official.attemptId}`, { headers: { cookie } });
    const result = await resultResponse.json();
    const replayResponse = await fetch(`${base}/api/v1/spots/${spot.spotId}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, cookie }, body: JSON.stringify(request) });
    const replay = await replayResponse.json();
    const practiceResponse = await fetch(`${base}/api/v1/spots/${spot.spotId}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `${key}-practice`, cookie }, body: JSON.stringify(request) });
    const practice = await practiceResponse.json();
    createdAttemptIds.push(practice.attemptId);
    const conflicting = { ...request, hands: [{ combo: spot.featuredCombo, allocations: Object.fromEntries(actionIds.map((id, index) => [id, index === 0 ? 10_000 : 0])) }] };
    const conflictResponse = await fetch(`${base}/api/v1/spots/${spot.spotId}/attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, cookie }, body: JSON.stringify(conflicting) });
    const foreignResponse = await fetch(`${base}/api/v1/attempts/${official.attemptId}`);
    foreignToken = foreignResponse.headers.get("set-cookie")?.split(";", 1)[0]?.split("=", 2)[1];
    const statsResponse = await fetch(`${base}/api/v1/users/me/stats`, { headers: { cookie } });
    const stats = await statsResponse.json();

    // Assert
    assert.equal(spot.schemaVersion, 3);
    assert.equal(spot.preflop.status === "known" || spot.preflop.status === "unknown", true);
    if (spot.preflop.status === "known" && spot.preflop.scenarioId === "2bet_call") {
      assert.equal(spot.preflop.rangeAssumptions.ip.presetId, "2bet_ip");
      assert.equal(spot.preflop.rangeAssumptions.oop.presetId, "call_oop");
      assert.ok(spot.preflop.rangeAssumptions.ip.cells.length > 20);
      assert.ok(spot.preflop.rangeAssumptions.oop.cells.length > 20);
      assert.match(spot.preflop.actions[0].label, /opens to [0-9.]+ bb/);
    }
    assert.doesNotMatch(JSON.stringify(spot), /privateSolutionPayload|gtoBasisPoints|reachedRanges|reachWeight|frequencies/);
    assert.ok(spotResponse.headers.get("etag"));
    assert.ok(spotResponse.headers.get("x-request-id"));
    assert.equal(officialResponse.status, 201);
    assert.equal(official.attemptKind, "official");
    assert.equal(officialResponse.headers.get("location"), `/api/v1/attempts/${official.attemptId}`);
    assert.equal(resultResponse.status, 200);
    assert.equal(result.attemptId, official.attemptId);
    assert.ok(result.hands[0].actions.every((action) => Number.isInteger(action.gtoBasisPoints)));
    assert.equal(replay.attemptId, official.attemptId);
    assert.equal(practice.attemptKind, "practice");
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(foreignResponse.status, 403);
    assert.equal(statsResponse.status, 200);
    assert.equal(stats.spotsCompleted, 1);
  } finally {
    if (createdAttemptIds.length) {
      const attempts = await prisma.attempt.findMany({ where: { id: { in: createdAttemptIds } }, select: { guestIdentityId: true } });
      const identityIds = [...new Set(attempts.map((attempt) => attempt.guestIdentityId).filter(Boolean))];
      await prisma.attempt.deleteMany({ where: { id: { in: createdAttemptIds } } });
      if (identityIds.length) {
        await prisma.guestSession.deleteMany({ where: { identityId: { in: identityIds } } });
        await prisma.guestIdentity.deleteMany({ where: { id: { in: identityIds } } });
      }
    }
    if (foreignToken) {
      const tokenHash = createHash("sha256").update(`local-development-guest-cookie-secret:${foreignToken}`).digest("hex");
      const session = await prisma.guestSession.findUnique({ where: { tokenHash } });
      if (session) {
        await prisma.guestSession.delete({ where: { id: session.id } });
        await prisma.guestIdentity.delete({ where: { id: session.identityId } });
      }
    }
    await prisma.$disconnect();
  }
});
