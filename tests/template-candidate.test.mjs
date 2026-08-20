import assert from "node:assert/strict";
import test from "node:test";

import { deterministicSeed, retryDelayMs, validateTemplateConfig } from "../dist/solver/template.js";
import { rankCandidates } from "../dist/solver/candidate.js";
import { validateNormalizedEnvelope } from "../dist/solver/normalized.js";
import { ensureQueueSchedules, replenishmentPlan } from "../dist/queue.js";

function candidate(id, street, actor, reach, frequencies) {
  const publicPayload = {
    schemaVersion: 1, spotId: `candidate_${id}`, spotVersionId: `candidate_${id}_v1`, mode: "single_hand", publicationDate: "2026-08-19", slotOrder: 1,
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } }, history: [],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street, actor, allIn: { ip: false, oop: false } },
    legalActions: [{ id: "a0", type: "check", displayLabel: "Check", isAllIn: false }, { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", isAllIn: false }], featuredCombo: "AhAs",
  };
  const sourceHash = id.repeat(64).slice(0, 64);
  return validateNormalizedEnvelope({ schemaVersion: 1, sourceHash, publicPayload, privateSolutionPayload: { schemaVersion: 1, actionOrder: ["a0", "a1"], byCombo: { AhAs: { reachWeight: reach, frequencies } }, reachedRanges: { hero: {}, opponent: {} } }, candidateManifest: { sourceHash, path: [id], selectedCombo: "AhAs", fallbackUsed: false, rankingVersion: "1" }, provenance: { normalizerVersion: "1", selectionRankingVersion: "1" } });
}

test("template config and retry policy are deterministic", () => {
  assert.doesNotThrow(() => validateTemplateConfig({ pot: 50, effective_stack: 100, board: ["Qs", "Jh", "2h"], ranges: { ip: "AA", oop: "KK" } }));
  assert.throws(() => validateTemplateConfig({ pot: 50, effective_stack: 100, board: ["Qs", "Qs", "2h"], ranges: { ip: "AA", oop: "KK" } }), /unique/);
  assert.equal(deterministicSeed("template-a", "seed"), deterministicSeed("template-a", "seed"));
  assert.notEqual(deterministicSeed("template-a", "seed"), deterministicSeed("template-b", "seed"));
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 300_000);
});

test("candidate ranking prefers configured actor/street and rejects pure strategies", () => {
  const preferred = candidate("a", "turn", "ip", 0.6, { a0: 4_000, a1: 6_000 });
  const fallback = candidate("b", "flop", "oop", 0.99, { a0: 5_000, a1: 5_000 });
  const selected = rankCandidates([fallback, preferred], { preferredStreet: "turn", preferredActor: "ip", minimumReach: 0.1, minimumMixedActionBasisPoints: 100, minimumEntropy: 0.1 }, "seed");
  assert.equal(selected.envelope.publicPayload.spotId, "candidate_a");
  assert.throws(() => rankCandidates([candidate("c", "flop", "oop", 0.9, { a0: 10_000, a1: 0 })], {}, "seed"), /no valid mixed-strategy candidate/);
});

test("queue schedules are independent and replenishment is deterministic", async () => {
  const calls = [];
  await ensureQueueSchedules({ schedule: async (...args) => calls.push(args) });
  assert.deepEqual(calls.map((call) => [call[0], call[1], call[3].key]), [
    ["replenishment", "0 0 18 * * *", "pacific-replenishment"],
    ["publication", "0 0 0 * * *", "pacific-publication"],
  ]);
  assert.deepEqual(replenishmentPlan(2), { coverage: 2, deficit: 5, alert: true });
  assert.deepEqual(replenishmentPlan(7), { coverage: 7, deficit: 0, alert: false });
  assert.throws(() => replenishmentPlan(-1), /non-negative integers/);
});
