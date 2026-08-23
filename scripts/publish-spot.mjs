#!/usr/bin/env node
/**
 * Import one exported Solver bundle and append it to the next free Pacific
 * publication date. This is the non-interactive half of Solver's
 * `texassolver_tech_demo.py --publish` command.
 */
import { resolve } from "node:path";
import { createPrismaClient } from "../dist/db.js";
import { approveSpotVersion, addPacificDays, nextAvailablePacificDate, pacificDate, scheduleSpotVersion } from "../dist/publication.js";
import { ingestSpot } from "../dist/solver/ingest.js";

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token?.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    result[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function dateText(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function required(options, keys) {
  for (const key of keys) if (!options[key]) throw new Error(`missing --${key}`);
}

const options = args(process.argv.slice(2));
required(options, ["envelope", "input", "output", "log", "title", "family", "spot-id", "spot-version-id"]);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const prisma = createPrismaClient(process.env.DATABASE_URL);
const archiveRoot = resolve(options["archive-root"] ?? process.env.SOLVER_OUTPUTS_DIR ?? "../../SolverOutputs");

async function occupiedPublicationDates() {
  const slots = await prisma.publicationSlot.findMany({
    where: { status: { in: ["SCHEDULED", "HELD", "PUBLISHED"] } },
    select: { publicationDate: true },
  });
  return slots.map((slot) => dateText(slot.publicationDate));
}

async function chooseDate() {
  if (options["publication-date"]) return options["publication-date"];
  const start = addPacificDays(pacificDate(new Date()), 1);
  return nextAvailablePacificDate(start, await occupiedPublicationDates());
}

try {
  // A retry of this exact command is safe: a scheduled or published immutable
  // version already has its date, so do not create another template/run or
  // accidentally move it to a later day.
  let version = await prisma.spotVersion.findUnique({ where: { id: options["spot-version-id"] }, include: { publicationSlots: true } });
  if (!version) {
    const publicationDate = await chooseDate();
    const result = await ingestSpot(prisma, {
      envelopePath: options.envelope,
      inputPath: options.input,
      outputPath: options.output,
      logPath: options.log,
      ...(options.provenance ? { provenancePath: options.provenance } : {}),
      archiveRoot,
      title: options.title,
      familyId: options.family,
      ...(options["template-name"] ? { templateName: options["template-name"] } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
      spotId: options["spot-id"],
      spotVersionId: options["spot-version-id"],
      publicationDate,
      slotOrder: 1,
      ...(options["initial-actor"] ? { initialActor: options["initial-actor"] } : {}),
    });
    version = await prisma.spotVersion.findUniqueOrThrow({ where: { id: result.spotVersionId }, include: { publicationSlots: true } });
  }

  if (version.status === "VALIDATED") version = await approveSpotVersion(prisma, version.id);
  if (version.status === "APPROVED") {
    const publicationDate = typeof version.publicPayload?.publicationDate === "string"
      ? version.publicPayload.publicationDate
      : await chooseDate();
    const slot = await scheduleSpotVersion(prisma, version.id, publicationDate, 1);
    console.log(JSON.stringify({ action: "imported-and-scheduled", spotId: version.spotId, spotVersionId: version.id, publicationDate, slotOrder: slot.slotOrder, status: "SCHEDULED" }, null, 2));
  } else if (version.status === "SCHEDULED" || version.status === "PUBLISHED") {
    const slot = version.publicationSlots.find((item) => ["SCHEDULED", "HELD", "PUBLISHED"].includes(item.status));
    console.log(JSON.stringify({ action: "already-scheduled", spotId: version.spotId, spotVersionId: version.id, publicationDate: slot ? dateText(slot.publicationDate) : null, slotOrder: slot?.slotOrder ?? null, status: version.status }, null, 2));
  } else {
    throw new Error(`spot version ${version.id} is ${version.status}; it cannot be automatically scheduled`);
  }
} catch (error) {
  console.error(`spot publish failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
