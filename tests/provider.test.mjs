import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProviderEnvelope } from "../dist/solver/provider.js";
import { assertPublishableStrategyQuality } from "../dist/solver/normalized.js";

test("native provider envelope is normalized to the public/private application boundary", () => {
  const sourceHash = "c".repeat(64);
  const input = {
    publicPayload: {
      source: { solveHash: `sha256:${sourceHash}`, configurationHash: `sha256:${"d".repeat(64)}`, pathManifest: { steps: [{ kind: "action", solverLabel: "BET 25.000000" }] } },
      preflop: {
        status: "known", scenarioId: "3bet_call", label: "3-bet pot", summary: "BTN opens, SB 3-bets, and BTN calls.",
        actions: [
          { sequence: 1, actor: "ip", position: "BTN", type: "open", amountBb: 2.5, label: "BTN opens to 2.5 bb" },
          { sequence: 2, actor: "oop", position: "SB", type: "three_bet", amountBb: 10, label: "SB 3-bets to 10 bb" },
          { sequence: 3, actor: "ip", position: "BTN", type: "call", amountBb: 10, label: "BTN calls 10 bb" },
        ],
        rangeAssumptions: {
          ip: { presetId: "call_3bet_ip", label: "IP calling range", cells: [{ handClass: "99", inclusionBasisPoints: 7500 }] },
          oop: { presetId: "3bet_oop", label: "OOP 3-bet range", cells: [{ handClass: "AA", inclusionBasisPoints: 10000 }] },
        },
      },
      initialState: { pot: 50, effectiveStack: 100, board: ["Qs", "Jh", "2h"] },
      history: [{ kind: "action", actor: "oop", actionType: "bet", solverLabel: "BET 25.000000", amount: 25 }],
      decision: { street: "flop", board: ["Qs", "Jh", "2h"], actor: "ip", pot: 75, stacks: { ip: 100, oop: 75 }, allIn: { ip: false, oop: false } },
      legalActions: [
        { id: "a0", actor: "ip", type: "call", amount: 25, displayLabel: "Call 25", solverLabel: "CALL", isAllIn: false },
        { id: "a1", actor: "ip", type: "allin", amount: 100, displayLabel: "All-in", solverLabel: "ALLIN", isAllIn: true },
        { id: "a2", actor: "ip", type: "fold", displayLabel: "Fold", solverLabel: "FOLD", isAllIn: false },
      ],
      // Providers may serialize the featured holding in either card order;
      // normalization must publish the exact stored spelling.
      featuredCombo: "KcAc",
      selectableCombos: ["AhAs", "AcKc", "QhQc"],
    },
    privateSolutionPayload: {
      source: { solveHash: `sha256:${sourceHash}` },
      ranges: {
        ip: { combos: { AhAs: { normalizedReach: 0.4 }, KcKd: { normalizedReach: 0.4 }, QhQc: { normalizedReach: 0.2 } } },
        oop: { combos: { QcQd: { normalizedReach: 1 } } },
      },
      strategy: { actionOrder: ["a0", "a1", "a2"], byCombo: {
        AhAs: { reachWeight: 0.5, frequencies: { a0: 0.2, a1: 0.7, a2: 0.1 } },
        AcKc: { reachWeight: 0.5, frequencies: { a0: 0.9, a1: 0.05, a2: 0.05 } },
        // Independent rounding would produce 5001 + 5000 + 0 and then
        // incorrectly subtract one from the tiny final action.
        QhQc: { reachWeight: 0.2, frequencies: { a0: 0.50005, a1: 0.49995, a2: 0.0000000001 } },
      } },
    },
  };
  const normalized = normalizeProviderEnvelope(input, { spotId: "provider_spot_1", publicationDate: "2026-08-20" });
  assert.equal(normalized.publicPayload.spotId, "provider_spot_1");
  assert.equal(normalized.schemaVersion, 3);
  assert.equal(normalized.publicPayload.preflop.status, "known");
  assert.deepEqual(normalized.publicPayload.presentation.positions, { ip: "BTN", oop: "SB" });
  assert.equal(normalized.publicPayload.presentation.dealerActor, "ip");
  assert.equal(normalized.publicPayload.featuredCombo, "AcKc");
  assert.ok(normalized.publicPayload.selectableCombos.some((entry) => entry.combo === "AcKc"));
  assert.equal(normalized.publicPayload.history.at(-1).kind, "decision");
  assert.equal(normalized.provenance.configurationHash, "d".repeat(64));
  assert.equal(normalized.publicPayload.legalActions[1].type, "bet");
  assert.equal(normalized.privateSolutionPayload.byCombo.AhAs.frequencies.a1, 7_000);
  assert.equal(normalized.privateSolutionPayload.byCombo.AcKc.frequencies.a0, 9_000);
  assert.deepEqual(normalized.privateSolutionPayload.byCombo.QhQc.frequencies, { a0: 5_000, a1: 5_000, a2: 0 });
  assert.equal(Object.values(normalized.privateSolutionPayload.byCombo.QhQc.frequencies).reduce((sum, value) => sum + value, 0), 10_000);
  assert.ok(Object.values(normalized.privateSolutionPayload.byCombo.QhQc.frequencies).every((value) => value >= 0));
  assert.notDeepEqual(normalized.privateSolutionPayload.byCombo.AhAs.frequencies, normalized.privateSolutionPayload.byCombo.AcKc.frequencies);
  assert.equal(normalized.privateSolutionPayload.actionOrder.length, 3);
  assert.equal(normalized.candidateManifest.sourceHash, sourceHash);
  assert.equal(normalized.privateSolutionPayload.reachedRanges.hero.AhAs, 0.4);
  assert.equal(normalized.provenance.strategyDiversity.comboCount, 3);
  assert.equal(normalized.provenance.strategyDiversity.distinctVectorCount, 3);
  assert.equal(normalized.provenance.strategyDiversity.uniformAcrossCombos, false);

  const impossibleDealer = structuredClone(input);
  impossibleDealer.publicPayload.presentation = { heroActor: "ip", dealerActor: "oop", positions: { ip: "BTN", oop: "SB" }, holdingVisibility: "featured_hero", chipUnit: "bb" };
  assert.throws(
    () => normalizeProviderEnvelope(impossibleDealer, { spotId: "provider_spot_bad_dealer", publicationDate: "2026-08-20" }),
    /dealer actor oop conflicts with BTN actor ip/,
  );

  const numericalResidue = structuredClone(input);
  numericalResidue.publicPayload.selectableCombos.push("KcQd");
  numericalResidue.privateSolutionPayload.ranges.ip.combos.KcQd = {
    rawReach: 1.5e-12,
    normalizedReach: 1.5e-12,
  };
  numericalResidue.privateSolutionPayload.strategy.byCombo.KcQd = {
    rawReach: 1.5e-12,
    reachWeight: 1.5e-12,
    frequencies: { a0: 1, a1: 0, a2: 0 },
  };
  assert.throws(
    () => normalizeProviderEnvelope(numericalResidue, { spotId: "provider_spot_residue", publicationDate: "2026-08-20" }),
    /selectable combo KcQd is inactive/,
  );
});

test("strategy diversity is a diagnostic and flags uniform vectors without rejecting pure strategies", () => {
  const sourceHash = "e".repeat(64);
  const base = {
    publicPayload: {
      source: { solveHash: `sha256:${sourceHash}`, pathManifest: { steps: [] } },
      initialState: { pot: 10, effectiveStack: 100, board: ["Qs", "Jh", "2h"] },
      history: [],
      decision: { street: "flop", board: ["Qs", "Jh", "2h"], actor: "oop", pot: 10, stacks: { ip: 100, oop: 100 }, allIn: { ip: false, oop: false } },
      legalActions: [
        { id: "a0", actor: "oop", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false },
        { id: "a1", actor: "oop", type: "bet", amount: 5, displayLabel: "Bet 5", solverLabel: "BET 5.000000", isAllIn: false },
      ],
      featuredCombo: "8s8h",
      selectableCombos: ["8s8h", "AcKc"],
    },
    privateSolutionPayload: {
      source: { solveHash: `sha256:${sourceHash}` },
      ranges: { ip: { combos: { AcKc: { normalizedReach: 1 } } }, oop: { combos: { "8s8h": { normalizedReach: 1 }, AcKc: { normalizedReach: 1 } } } },
      strategy: { actionOrder: ["a0", "a1"], byCombo: { "8s8h": { reachWeight: 1, frequencies: { a0: 1, a1: 0 } }, AcKc: { reachWeight: 1, frequencies: { a0: 1, a1: 0 } } } },
    },
  };

  const normalized = normalizeProviderEnvelope(base, { spotId: "uniform_spot", publicationDate: "2026-08-20" });
  assert.equal(normalized.provenance.strategyDiversity.uniformAcrossCombos, true);
  assert.equal(normalized.provenance.strategyDiversity.warning, "all selectable combos have the same strategy vector");
  // A uniform check strategy with only two actions is not sufficient evidence
  // of provider corruption and remains publishable.
  assert.doesNotThrow(() => assertPublishableStrategyQuality(normalized));
});

test("publication quality rejects the legacy uniform all-in collapse", () => {
  const sourceHash = "f".repeat(64);
  const input = {
    publicPayload: {
      source: { solveHash: `sha256:${sourceHash}`, pathManifest: { steps: [] } },
      initialState: { pot: 50, effectiveStack: 100, board: ["Qs", "Jh", "2h"] },
      history: [],
      decision: { street: "flop", board: ["Qs", "Jh", "2h"], actor: "oop", pot: 50, stacks: { ip: 100, oop: 100 }, allIn: { ip: false, oop: false } },
      legalActions: [
        { id: "a0", actor: "oop", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false },
        { id: "a1", actor: "oop", type: "bet", amount: 17, displayLabel: "Bet 17", solverLabel: "BET 17.000000", isAllIn: false },
        { id: "a2", actor: "oop", type: "bet", amount: 100, displayLabel: "Bet 100", solverLabel: "BET 100.000000", isAllIn: true },
      ],
      featuredCombo: "8s8h",
      selectableCombos: ["8s8h", "AcKc"],
    },
    privateSolutionPayload: {
      source: { solveHash: `sha256:${sourceHash}` },
      ranges: { ip: { combos: { AcKc: { normalizedReach: 1 } } }, oop: { combos: { "8s8h": { normalizedReach: 1 }, AcKc: { normalizedReach: 1 } } } },
      strategy: { actionOrder: ["a0", "a1", "a2"], byCombo: {
        "8s8h": { reachWeight: 1, frequencies: { a0: 0, a1: 0, a2: 1 } },
        AcKc: { reachWeight: 1, frequencies: { a0: 0, a1: 0, a2: 1 } },
      } },
    },
  };

  const normalized = normalizeProviderEnvelope(input, { spotId: "collapsed_spot", publicationDate: "2026-08-20" });
  assert.throws(
    () => assertPublishableStrategyQuality(normalized),
    /all 2 selectable combos use the same 100% Bet 100 vector across 3 legal actions/,
  );
});

test("publication quality rejects a large uniform call-fold range", () => {
  const sourceHash = "a".repeat(64);
  const combos = Array.from({ length: 20 }, (_, index) => `combo_${index}`);
  const envelope = {
    schemaVersion: 3,
    sourceHash,
    publicPayload: {
      schemaVersion: 3,
      spotId: "large_uniform_spot",
      spotVersionId: "large_uniform_spot_v1",
      publicationDate: "2026-08-20",
      slotOrder: 1,
      preflop: { status: "unknown", label: "Preflop start unavailable", summary: "Test." },
      initialState: { board: ["Qs", "Jh", "2h", "Ks"], pot: 167, stacks: { ip: 83, oop: 0 }, street: "turn", actor: "ip", allIn: { ip: false, oop: true } },
      history: [],
      decision: { board: ["Qs", "Jh", "2h", "Ks"], pot: 167, stacks: { ip: 83, oop: 0 }, street: "turn", actor: "ip", allIn: { ip: false, oop: true } },
      legalActions: [
        { id: "a0", type: "call", amount: 83, displayLabel: "Call 83", solverLabel: "CALL", isAllIn: true },
        { id: "a1", type: "fold", displayLabel: "Fold", solverLabel: "FOLD", isAllIn: false },
      ],
      featuredCombo: combos[0],
      selectableCombos: combos.map((combo) => ({ combo, category: "offsuit" })),
      presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
    },
    privateSolutionPayload: {
      schemaVersion: 1,
      actionOrder: ["a0", "a1"],
      byCombo: Object.fromEntries(combos.map((combo) => [combo, { reachWeight: 0.01, frequencies: { a0: 10_000, a1: 0 } }])),
      reachedRanges: { hero: {}, opponent: {} },
    },
    candidateManifest: { sourceHash, path: [], selectedCombo: combos[0], fallbackUsed: false, rankingVersion: "1" },
    provenance: { normalizerVersion: "test", selectionRankingVersion: "1" },
  };

  assert.throws(
    () => assertPublishableStrategyQuality(envelope),
    /all 20 selectable combos use the same 100% Call 83 vector across 2 legal actions/,
  );
});

test("publication quality allows a large uniform check range", () => {
  const sourceHash = "b".repeat(64);
  const combos = Array.from({ length: 40 }, (_, index) => `combo_${index}`);
  const envelope = {
    schemaVersion: 3,
    sourceHash,
    publicPayload: {
      schemaVersion: 3,
      spotId: "large_uniform_check_spot",
      spotVersionId: "large_uniform_check_spot_v1",
      publicationDate: "2026-08-20",
      slotOrder: 1,
      preflop: { status: "unknown", label: "Preflop start unavailable", summary: "Test." },
      initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
      history: [],
      decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
      legalActions: [
        { id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false },
        { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", solverLabel: "BET 25.000000", isAllIn: false },
      ],
      featuredCombo: combos[0],
      selectableCombos: combos.map((combo) => ({ combo, category: "offsuit" })),
      presentation: { heroActor: "oop", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
    },
    privateSolutionPayload: {
      schemaVersion: 1,
      actionOrder: ["a0", "a1"],
      byCombo: Object.fromEntries(combos.map((combo) => [combo, { reachWeight: 0.01, frequencies: { a0: 10_000, a1: 0 } }])),
      reachedRanges: { hero: {}, opponent: {} },
    },
    candidateManifest: { sourceHash, path: [], selectedCombo: combos[0], fallbackUsed: false, rankingVersion: "1" },
    provenance: { normalizerVersion: "test", selectionRankingVersion: "1" },
  };

  assert.doesNotThrow(() => assertPublishableStrategyQuality(envelope));
});
