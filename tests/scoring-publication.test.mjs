import assert from "node:assert/strict";
import test from "node:test";

import { addPacificDays, assertLifecycleTransition, pacificDate, pacificMidnightUtc } from "../dist/publication.js";
import { getSimilarityMetric, scoreHands } from "../dist/scoring.js";

test("L1 scoring uses basis points and returns signed per-action deltas", () => {
  const result = scoreHands(["a0", "a1", "a2"], { a0: 7_290, a1: 2_710, a2: 0 }, { a0: 7_291, a1: 2_709, a2: 0 });
  assert.equal(result.similarity, 99.99);
  assert.deepEqual(result.actions[0], { actionId: "a0", submittedBasisPoints: 7290, gtoBasisPoints: 7291, signedDifferenceBasisPoints: -1, absoluteDifferenceBasisPoints: 1 });
  assert.equal(result.gtoMajorityActionId, "a0");
  assert.equal(getSimilarityMetric("l1", 1).key, "l1");
  assert.throws(() => getSimilarityMetric("unknown", 1), /unknown similarity metric/);
});

test("Pacific publication helpers handle DST and calendar arithmetic", () => {
  assert.equal(pacificDate(new Date("2026-08-20T06:59:59.000Z")), "2026-08-19");
  assert.equal(pacificDate(new Date("2026-08-20T07:00:00.000Z")), "2026-08-20");
  assert.equal(pacificMidnightUtc("2026-01-15").toISOString(), "2026-01-15T08:00:00.000Z");
  assert.equal(pacificMidnightUtc("2026-07-15").toISOString(), "2026-07-15T07:00:00.000Z");
  assert.equal(addPacificDays("2026-08-20", 7), "2026-08-27");
  assert.throws(() => addPacificDays("2026-02-30", 1), /publication date is invalid/);
  assert.throws(() => pacificMidnightUtc("not-a-date"), /publication date must be YYYY-MM-DD/);
});

test("spot version lifecycle rejects skips and allows only guarded advances", async () => {
  assert.doesNotThrow(() => assertLifecycleTransition("DRAFT", "VALIDATED"));
  assert.doesNotThrow(() => assertLifecycleTransition("VALIDATED", "APPROVED"));
  assert.doesNotThrow(() => assertLifecycleTransition("APPROVED", "SCHEDULED"));
  assert.doesNotThrow(() => assertLifecycleTransition("SCHEDULED", "PUBLISHED"));
  assert.throws(() => assertLifecycleTransition("DRAFT", "PUBLISHED"), /invalid spot version transition/);
  assert.throws(() => assertLifecycleTransition("PUBLISHED", "APPROVED"), /invalid spot version transition/);
});
