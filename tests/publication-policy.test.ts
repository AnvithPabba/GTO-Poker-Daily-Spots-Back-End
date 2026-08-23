import { describe, expect, it } from "vitest";
import { nextAvailablePacificDate } from "../src/publication.js";

describe("automatic publication-date allocation", () => {
  it.each([
    ["2026-08-23", [], "2026-08-23"],
    ["2026-08-23", ["2026-08-23"], "2026-08-24"],
    ["2026-08-23", ["2026-08-24", "2026-08-25"], "2026-08-23"],
    ["2026-03-08", ["2026-03-08"], "2026-03-09"],
  ])("chooses the first free calendar day without sorting assumptions", (start, occupied, expected) => {
    // Arrange: the caller has read all reserved slot dates from Postgres.

    // Act
    const result = nextAvailablePacificDate(start, occupied);

    // Assert
    expect(result).toBe(expected);
  });

  it("rejects malformed dates instead of creating an invalid slot", () => {
    expect(() => nextAvailablePacificDate("2026-02-30", [])).toThrow(/invalid/);
  });
});
