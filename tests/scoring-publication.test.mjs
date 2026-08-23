import assert from "node:assert/strict";
import test from "node:test";

import { addPacificDays, assertLifecycleTransition, pacificDate, pacificMidnightUtc } from "../dist/publication.js";
import { resolveExactComboStrategy } from "../dist/application/public-api.js";
import { getSimilarityMetric, scoreHands } from "../dist/scoring.js";

test("L1 scoring uses basis points and returns signed per-action deltas", () => {
  const result = scoreHands(["a0", "a1", "a2"], { a0: 7_290, a1: 2_710, a2: 0 }, { a0: 7_291, a1: 2_709, a2: 0 });
  assert.equal(result.similarity, 99.99);
  assert.deepEqual(result.actions[0], { actionId: "a0", submittedBasisPoints: 7290, gtoBasisPoints: 7291, signedDifferenceBasisPoints: -1, absoluteDifferenceBasisPoints: 1 });
  assert.equal(result.gtoMajorityActionId, "a0");
  assert.equal(getSimilarityMetric("l1", 1).key, "l1");
  assert.throws(() => getSimilarityMetric("unknown", 1), /unknown similarity metric/);
});

test("exact-combo scoring preserves distinct stored strategies", () => {
  // Arrange
  const actionOrder = ["check", "jam"];
  const submitted = { check: 5_000, jam: 5_000 };
  const byCombo = {
    "8s8h": { check: 10_000, jam: 0 },
    "AcKc": { check: 2_500, jam: 7_500 },
  };

  // Act
  const eights = scoreHands(actionOrder, submitted, byCombo["8s8h"]);
  const aceKing = scoreHands(actionOrder, submitted, byCombo["AcKc"]);

  // Assert
  assert.notEqual(eights.similarity, aceKing.similarity);
  assert.equal(eights.gtoMajorityActionId, "check");
  assert.equal(aceKing.gtoMajorityActionId, "jam");
  assert.equal(eights.actions[0].gtoBasisPoints, 10_000);
  assert.equal(aceKing.actions[0].gtoBasisPoints, 2_500);
});

test("exact-combo resolver selects the requested DB entry and never a featured fallback", () => {
  // Arrange: the private JSONB payload has different vectors for each exact
  // combo, with one entry stored in the opposite card order.
  const solution = {
    actionOrder: ["check", "jam"],
    byCombo: {
      "8s8h": { frequencies: { check: 10_000, jam: 0 } },
      "KcAc": { frequencies: { check: 2_500, jam: 7_500 } },
    },
  };

  // Act
  const eights = resolveExactComboStrategy(solution, "8s8h");
  const aceKing = resolveExactComboStrategy(solution, "AcKc");
  const absent = resolveExactComboStrategy(solution, "QhQc");
  const equalSubmission = { check: 5_000, jam: 5_000 };
  const eightsScore = scoreHands(solution.actionOrder, equalSubmission, eights.frequencies);
  const aceKingScore = scoreHands(solution.actionOrder, equalSubmission, aceKing.frequencies);

  // Assert
  assert.deepEqual(eights?.frequencies, { check: 10_000, jam: 0 });
  assert.deepEqual(aceKing?.frequencies, { check: 2_500, jam: 7_500 });
  assert.equal(absent, undefined);
  assert.notEqual(eightsScore.similarity, aceKingScore.similarity);
  assert.equal(eightsScore.gtoMajorityActionId, "check");
  assert.equal(aceKingScore.gtoMajorityActionId, "jam");
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
