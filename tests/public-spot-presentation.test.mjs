import assert from "node:assert/strict";
import test from "node:test";

import { readPublicSpot } from "../dist/application/public-api.js";

function legacySpot() {
  return {
    schemaVersion: 3,
    spotId: "legacy_position_spot",
    spotVersionId: "legacy_position_spot_v1",
    publicationDate: "2026-08-23",
    slotOrder: 1,
    preflop: {
      status: "known",
      scenarioId: "2bet_call",
      label: "BTN opens, BB calls",
      summary: "BTN opens and BB calls.",
      actions: [
        { sequence: 1, actor: "ip", position: "BTN", type: "open", amountBb: 2.5, label: "BTN opens to 2.5 bb" },
        { sequence: 2, actor: "oop", position: "BB", type: "call", amountBb: 2.5, label: "BB calls" },
      ],
      rangeAssumptions: {
        ip: { presetId: "2bet_ip", label: "BTN range", cells: [{ handClass: "AA", inclusionBasisPoints: 10_000 }] },
        oop: { presetId: "call_oop", label: "BB range", cells: [{ handClass: "KQs", inclusionBasisPoints: 10_000 }] },
      },
    },
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    history: [{ kind: "decision", actor: "oop" }],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    legalActions: [{ id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false }],
    featuredCombo: "8s8h",
    selectableCombos: [{ combo: "8s8h", category: "pair" }],
    presentation: { heroActor: "oop", dealerActor: "oop", positions: { ip: "IP", oop: "OOP" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
}

test("public read reconciles legacy generic positions and dealer from preflop BTN/BB", () => {
  // Arrange
  const stored = legacySpot();

  // Act
  const publicSpot = readPublicSpot(stored);

  // Assert
  assert.deepEqual(publicSpot.presentation.positions, { ip: "BTN", oop: "BB" });
  assert.equal(publicSpot.presentation.dealerActor, "ip");
  assert.equal(publicSpot.presentation.heroActor, "oop");
  assert.equal(publicSpot.decision.actor, "oop");
});

test("public read rejects an explicit position that contradicts preflop actions", () => {
  // Arrange
  const stored = legacySpot();
  stored.presentation.positions.ip = "CO";

  // Act / Assert
  assert.throws(() => readPublicSpot(stored), /position for ip conflicts with preflop actions/);
});
