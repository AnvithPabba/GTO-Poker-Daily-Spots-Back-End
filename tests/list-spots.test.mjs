import assert from "node:assert/strict";
import test from "node:test";

import { renderSpotTable, resolveListWindow, rowsForSlots } from "../scripts/list-spots.mjs";

test("spot monitor defaults to five Pacific days before and after today", () => {
  // Arrange
  const now = new Date("2026-08-23T19:00:00.000Z");

  // Act
  const window = resolveListWindow([], now);

  // Assert
  assert.deepEqual(window, { from: "2026-08-18", to: "2026-08-28", includeCancelled: false, json: false });
});

test("spot monitor accepts an exact inclusive range and audit flags", () => {
  const window = resolveListWindow([
    "--from", "2026-08-01", "--to", "2026-08-31", "--include-cancelled", "--json",
  ]);

  assert.deepEqual(window, { from: "2026-08-01", to: "2026-08-31", includeCancelled: true, json: true });
});

test("spot monitor rejects incomplete, reversed, and invalid ranges", () => {
  const cases = [
    ["--from", "2026-08-01"],
    ["--from", "2026-08-31", "--to", "2026-08-01"],
    ["--before", "-1"],
    ["--from", "2026-02-30", "--to", "2026-03-01"],
  ];
  for (const args of cases) assert.throws(() => resolveListWindow(args));
});

test("spot monitor distinguishes valid and invalidated attempts without exposing solutions", () => {
  const slots = [{
    publicationDate: new Date("2026-08-23T00:00:00.000Z"),
    slotOrder: 1,
    status: "PUBLISHED",
    spotVersion: {
      id: "spot-v2",
      status: "PUBLISHED",
      validationReport: { quality: { lastTotalPercent: 0.053604126 } },
      spot: { id: "spot", title: "Flop decision" },
      attempts: [{ validity: "VALID" }, { validity: "INVALIDATED" }],
    },
  }];

  const rows = rowsForSlots(slots);
  const output = renderSpotTable(rows, { from: "2026-08-18", to: "2026-08-28" });

  assert.equal(rows[0].validAttempts, 1);
  assert.equal(rows[0].invalidatedAttempts, 1);
  assert.match(output, /spot-v2/);
  assert.match(output, /0\.0536%/);
  assert.doesNotMatch(output, /privateSolution|byCombo|frequencies/);
});
