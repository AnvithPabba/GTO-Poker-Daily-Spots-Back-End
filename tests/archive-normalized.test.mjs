import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { archiveRun, verifyArchive, archiveKeyToPath } from "../dist/solver/archive.js";
import { normalizedEnvelopeSchema, payloadSha256, validateNormalizedEnvelope } from "../dist/solver/normalized.js";

const sourceHash = "a".repeat(64);

function envelope(overrides = {}) {
  const publicPayload = {
    schemaVersion: 3,
    spotId: "unit_spot_001",
    spotVersionId: "unit_spot_001_v1",
    publicationDate: "2026-08-19",
    slotOrder: 1,
    preflop: { status: "unknown", label: "Preflop start unavailable", summary: "Legacy fixture." },
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    history: [],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    legalActions: [
      { id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false },
      { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", solverLabel: "BET 25.000000", isAllIn: false },
    ],
    featuredCombo: "AhAs",
    selectableCombos: [{ combo: "AhAs", category: "pair" }],
    presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
  return {
    schemaVersion: 3,
    sourceHash,
    publicPayload,
    privateSolutionPayload: {
      schemaVersion: 1,
      actionOrder: ["a0", "a1"],
      byCombo: { AhAs: { reachWeight: 0.8, frequencies: { a0: 2_500, a1: 7_500 } } },
      reachedRanges: { hero: { AhAs: 0.8 }, opponent: { KcKd: 1 } },
    },
    candidateManifest: { sourceHash, path: ["root", "decision"], selectedCombo: "AhAs", fallbackUsed: false, rankingVersion: "1" },
    provenance: { normalizerVersion: "1", selectionRankingVersion: "1" },
    ...overrides,
  };
}

test("archive is content-addressed, append-only, and checksum verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "poker-archive-"));
  const archived = await archiveRun(root, [
    { name: "input.txt", content: "set_pot 50\n" },
    { name: "output_result.json", content: "{\"node\":true}\n" },
    { name: "solver.log", content: "completed\n" },
  ]);
  await verifyArchive(root, archived);
  assert.match(archived.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(archiveKeyToPath(root, archived.artifacts["input.txt"].key), "utf8"), "set_pot 50\n");
  await writeFile(join(root, archived.artifacts["input.txt"].key), "tampered-input\n");
  await assert.rejects(() => archiveRun(root, [
    { name: "input.txt", content: "set_pot 50\n" },
    { name: "output_result.json", content: "{\"node\":true}\n" },
    { name: "solver.log", content: "completed\n" },
  ]), /conflicting archive replacement/);
  await writeFile(join(root, archived.artifacts["solver.log"].key), "tampered\n");
  await assert.rejects(() => verifyArchive(root, archived), /checksum mismatch/);
});

test("archive preserves conflicting metadata observations as append-only versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "poker-archive-metadata-"));
  const source = [
    { name: "input.txt", content: "set_pot 50\n" },
    { name: "output_result.json", content: "{\"node\":true}\n" },
    { name: "solver.log", content: "completed\n" },
  ];

  const rejected = await archiveRun(root, [...source, { name: "metadata.json", content: "{\"status\":\"rejected\"}" }]);
  const accepted = await archiveRun(root, [...source, { name: "metadata.json", content: "{\"status\":\"accepted\"}" }]);

  assert.equal(rejected.sourceHash, accepted.sourceHash);
  assert.notEqual(rejected.artifacts["metadata.json"].key, accepted.artifacts["metadata.json"].key);
  assert.match(accepted.artifacts["metadata.json"].key, /metadata-[a-f0-9]{64}\.json$/);
  await verifyArchive(root, rejected);
  await verifyArchive(root, accepted);
});

test("normalized envelope enforces action identity, sums, and public/private boundary", () => {
  const valid = validateNormalizedEnvelope(envelope());
  assert.equal(payloadSha256(valid.publicPayload), payloadSha256({ ...valid.publicPayload }));
  assert.doesNotThrow(() => normalizedEnvelopeSchema.parse(valid));

  assert.throws(() => validateNormalizedEnvelope({
    ...valid,
    publicPayload: { ...valid.publicPayload, legalActions: [...valid.publicPayload.legalActions, { id: "a2", type: "fold", displayLabel: "Fold", solverLabel: "FOLD", isAllIn: false }] },
  }), /action order mismatch/);
  assert.throws(() => validateNormalizedEnvelope({
    ...valid,
    privateSolutionPayload: { ...valid.privateSolutionPayload, byCombo: { AhAs: { reachWeight: 1, frequencies: { a0: 1, a1: 9_998 } } } },
  }), /total 10000/);
  assert.throws(() => validateNormalizedEnvelope({
    ...valid,
    publicPayload: { ...valid.publicPayload, strategy: { frequencies: { a0: 1 } } },
  }), /Unrecognized key/);
  assert.throws(() => validateNormalizedEnvelope({
    ...valid,
    candidateManifest: { ...valid.candidateManifest, sourceHash: "b".repeat(64) },
  }), /source hash mismatch/);

  const knownPreflop = {
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
      oop: { presetId: "call_oop", label: "BB range", cells: [{ handClass: "KQs", inclusionBasisPoints: 7_500 }] },
    },
  };
  assert.throws(() => validateNormalizedEnvelope({
    ...valid,
    publicPayload: { ...valid.publicPayload, preflop: knownPreflop, presentation: { ...valid.publicPayload.presentation, dealerActor: "oop" } },
  }), /dealer actor does not match BTN/);
  assert.throws(() => validateNormalizedEnvelope({
    ...valid,
    publicPayload: { ...valid.publicPayload, preflop: knownPreflop, presentation: { ...valid.publicPayload.presentation, positions: { ip: "CO", oop: "BB" } } },
  }), /position for ip does not match preflop actions/);
});
