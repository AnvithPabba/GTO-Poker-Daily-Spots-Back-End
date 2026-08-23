#!/usr/bin/env node
/** List publication coverage around a Pacific date or across an exact range. */
import { pathToFileURL } from "node:url";
import { createPrismaClient } from "../dist/db.js";
import { addPacificDays, pacificDate } from "../dist/publication.js";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token?.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[token.slice(2)] = true;
    else {
      result[token.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3660) throw new Error(`--${name} must be an integer from 0 to 3660`);
  return parsed;
}

function isoDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--${name} must use YYYY-MM-DD`);
  // Reuse the publication helper's strict calendar validation.
  addPacificDays(value, 0);
  return value;
}

export function resolveListWindow(argv, now = new Date()) {
  const options = parseArgs(argv);
  const hasFrom = options.from !== undefined;
  const hasTo = options.to !== undefined;
  if (hasFrom !== hasTo) throw new Error("--from and --to must be supplied together");
  let from;
  let to;
  if (hasFrom) {
    from = isoDate(options.from, "from");
    to = isoDate(options.to, "to");
    if (from > to) throw new Error("--from must be on or before --to");
  } else {
    const before = nonNegativeInteger(options.before, "before", 5);
    const after = nonNegativeInteger(options.after, "after", 5);
    const today = pacificDate(now);
    from = addPacificDays(today, -before);
    to = addPacificDays(today, after);
  }
  return {
    from,
    to,
    includeCancelled: options["include-cancelled"] === true,
    json: options.json === true,
  };
}

function dateText(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function qualitySummary(report) {
  if (!report || typeof report !== "object") return "unknown";
  const quality = report.quality ?? report.solverQuality;
  if (!quality || typeof quality !== "object") return "valid";
  const exploitability = Number(quality.lastTotalPercent ?? quality.totalExploitabilityPercent);
  return Number.isFinite(exploitability) ? `${exploitability.toFixed(4)}%` : "valid";
}

export function rowsForSlots(slots) {
  return slots.map((slot) => ({
    date: dateText(slot.publicationDate),
    order: slot.slotOrder,
    slotStatus: slot.status,
    spotId: slot.spotVersion.spot.id,
    title: slot.spotVersion.spot.title,
    spotVersionId: slot.spotVersion.id,
    versionStatus: slot.spotVersion.status,
    validAttempts: slot.spotVersion.attempts.filter((attempt) => attempt.validity === "VALID").length,
    invalidatedAttempts: slot.spotVersion.attempts.filter((attempt) => attempt.validity === "INVALIDATED").length,
    quality: qualitySummary(slot.spotVersion.validationReport),
  }));
}

function cell(value, width) {
  const text = String(value ?? "-");
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text.padEnd(width);
}

export function renderSpotTable(rows, window) {
  const lines = [`Publication slots · ${window.from} through ${window.to} · Pacific`];
  if (!rows.length) return `${lines[0]}\nNo publication slots in this window.`;
  lines.push(
    [cell("DATE", 10), cell("#", 2), cell("SLOT", 10), cell("VERSION", 12), cell("ATT", 7), cell("QUALITY", 10), "SPOT / TITLE"].join("  "),
  );
  for (const row of rows) {
    lines.push([
      cell(row.date, 10),
      cell(row.order, 2),
      cell(row.slotStatus, 10),
      cell(row.versionStatus, 12),
      cell(`${row.validAttempts}/${row.invalidatedAttempts}`, 7),
      cell(row.quality, 10),
      `${row.spotId} · ${row.title}`,
    ].join("  "));
    lines.push(`    version: ${row.spotVersionId}`);
  }
  lines.push("ATT = valid/invalidated attempts. Use --include-cancelled for replacement history.");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), now = new Date()) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const window = resolveListWindow(argv, now);
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const slots = await prisma.publicationSlot.findMany({
      where: {
        publicationDate: {
          gte: new Date(`${window.from}T00:00:00.000Z`),
          lte: new Date(`${window.to}T00:00:00.000Z`),
        },
        ...(!window.includeCancelled ? { status: { in: ["SCHEDULED", "HELD", "PUBLISHED"] } } : {}),
      },
      orderBy: [{ publicationDate: "asc" }, { slotOrder: "asc" }, { createdAt: "asc" }],
      select: {
        publicationDate: true,
        slotOrder: true,
        status: true,
        spotVersion: {
          select: {
            id: true,
            status: true,
            validationReport: true,
            spot: { select: { id: true, title: true } },
            attempts: { select: { validity: true } },
          },
        },
      },
    });
    const rows = rowsForSlots(slots);
    console.log(window.json ? JSON.stringify({ window: { from: window.from, to: window.to, timezone: "America/Los_Angeles" }, spots: rows }, null, 2) : renderSpotTable(rows, window));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`spot list failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
