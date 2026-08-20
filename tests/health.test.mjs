import assert from "node:assert/strict";
import test from "node:test";

import { liveHealthPayload, readinessPayload } from "../dist/health.js";

test("liveness does not require a database", () => {
  assert.deepEqual(liveHealthPayload("api"), { service: "api", status: "ok" });
});

test("readiness reports a healthy database", async () => {
  const result = await readinessPayload({ query: async () => ({ rowCount: 1 }) }, "api");
  assert.deepEqual(result, {
    body: { checks: { database: "ok" }, service: "api", status: "ok" },
    statusCode: 200,
  });
});

test("readiness returns 503 when the database is unavailable", async () => {
  const result = await readinessPayload({ query: async () => { throw new Error("database is down"); } }, "worker");
  assert.deepEqual(result, {
    body: { checks: { database: "failed" }, service: "worker", status: "unready" },
    statusCode: 503,
  });
});
