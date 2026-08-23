import { describe, expect, it } from "vitest";
import { assertImportProvenance, normalizeSolverRange } from "../src/solver/import-provenance.js";

const provenance = {
  schemaVersion: 1,
  configurationHash: "a".repeat(64),
  preflop: { status: "known", scenarioId: "2bet_call", summary: "BTN opens to 2.5 bb and BB calls." },
  resolvedRanges: { ip: "AA:1.0,AKs:0.75", oop: "KK:1.0,KQs:0.5" },
};

const envelope = {
  publicPayload: { source: { configurationHash: provenance.configurationHash }, preflop: provenance.preflop },
};

describe("solver import provenance", () => {
  it("normalizes range token ordering without changing token values", () => {
    expect(normalizeSolverRange(" AKs:0.75, AA:1.0 ")).toBe("AA:1.0,AKs:0.75");
  });

  it("accepts a provider envelope whose ranges match the generated input", () => {
    expect(() => assertImportProvenance(envelope, provenance, "set_range_ip AKs:0.75,AA:1.0\nset_range_oop KQs:0.5,KK:1.0\n")).not.toThrow();
  });

  it.each([
    ["missing configuration hash", { ...provenance, configurationHash: undefined }, /configuration provenance is required/],
    ["different configuration hash", { ...provenance, configurationHash: "b".repeat(64) }, /configurationHash does not match/],
    ["different preflop story", { ...provenance, preflop: { ...provenance.preflop, summary: "fabricated" } }, /preflop story does not match/],
    ["different IP range", { ...provenance, resolvedRanges: { ...provenance.resolvedRanges, ip: "AA:1.0" } }, /IP range does not match/],
    ["different OOP range", { ...provenance, resolvedRanges: { ...provenance.resolvedRanges, oop: "KK:1.0" } }, /OOP range does not match/],
  ])("rejects %s", (_label, invalid, expected) => {
    expect(() => assertImportProvenance(envelope, invalid, "set_range_ip AKs:0.75,AA:1.0\nset_range_oop KQs:0.5,KK:1.0\n")).toThrow(expected);
  });
});
