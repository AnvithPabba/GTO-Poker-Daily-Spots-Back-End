import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProviderEnvelope } from "../dist/solver/provider.js";

test("native provider envelope is normalized to the public/private application boundary", () => {
  const sourceHash = "c".repeat(64);
  const input = {
    publicPayload: {
      source: { solveHash: `sha256:${sourceHash}`, pathManifest: { steps: [{ kind: "action", solverLabel: "BET 25.000000" }] } },
      initialState: { pot: 50, effectiveStack: 100, board: ["Qs", "Jh", "2h"] },
      history: [{ kind: "action", actor: "oop", actionType: "bet", solverLabel: "BET 25.000000", amount: 25 }],
      decision: { street: "flop", board: ["Qs", "Jh", "2h"], actor: "ip", pot: 75, stacks: { ip: 100, oop: 75 }, allIn: { ip: false, oop: false } },
      legalActions: [
        { id: "a0", actor: "ip", type: "call", amount: 25, displayLabel: "Call 25", solverLabel: "CALL", isAllIn: false },
        { id: "a1", actor: "ip", type: "allin", amount: 100, displayLabel: "All-in", solverLabel: "ALLIN", isAllIn: true },
        { id: "a2", actor: "ip", type: "fold", displayLabel: "Fold", solverLabel: "FOLD", isAllIn: false },
      ],
      featuredCombo: "AhAs",
    },
    privateSolutionPayload: {
      source: { solveHash: `sha256:${sourceHash}` },
      ranges: {
        ip: { combos: { AhAs: { normalizedReach: 0.5 }, KcKd: { normalizedReach: 0.5 } } },
        oop: { combos: { QcQd: { normalizedReach: 1 } } },
      },
      strategy: { actionOrder: ["a0", "a1", "a2"], byCombo: { AhAs: { reachWeight: 0.5, frequencies: { a0: 0.2, a1: 0.7, a2: 0.1 } } } },
    },
  };
  const normalized = normalizeProviderEnvelope(input, { spotId: "provider_spot_1", publicationDate: "2026-08-20" });
  assert.equal(normalized.publicPayload.spotId, "provider_spot_1");
  assert.equal(normalized.publicPayload.legalActions[1].type, "bet");
  assert.equal(normalized.privateSolutionPayload.byCombo.AhAs.frequencies.a1, 7_000);
  assert.equal(normalized.privateSolutionPayload.actionOrder.length, 3);
  assert.equal(normalized.candidateManifest.sourceHash, sourceHash);
  assert.equal(normalized.privateSolutionPayload.reachedRanges.hero.AhAs, 0.5);
});
