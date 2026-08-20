import assert from "node:assert/strict";
import test from "node:test";

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
  const today = await get("/api/v1/spots/today");
  assert.equal(today.response.status, 200);
  assert.equal(today.body.timezone, "America/Los_Angeles");
  const serialized = JSON.stringify(today.body);
  assert.doesNotMatch(serialized, /privateSolutionPayload|gtoFrequencies|reachedRanges|reachWeight|frequencies/);
  const frontend = await fetch("http://127.0.0.1:4173/health/live");
  assert.equal(frontend.status, 200);
  const proxy = await fetch("http://127.0.0.1:4173/api/health/live");
  assert.equal(proxy.status, 200);
  const adminProxy = await fetch("http://127.0.0.1:4173/api/v1/admin/status");
  assert.equal(adminProxy.status, 200);
});
