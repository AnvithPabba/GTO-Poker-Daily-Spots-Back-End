#!/usr/bin/env node
/**
 * Import one exported Solver bundle and append it to the next free Pacific
 * publication date, target an exact empty date, or explicitly replace its
 * slot 1. This is the non-interactive half of Solver's publish command.
 */
import { resolve } from "node:path";
import { createPrismaClient } from "../dist/db.js";
import { approveSpotVersion, addPacificDays, nextAvailablePacificDate, pacificDate, publishPacificDate, replacePublishedSlot, scheduleSpotVersion } from "../dist/publication.js";
import { ingestSpot } from "../dist/solver/ingest.js";

function args(argv) {
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

function dateText(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function required(options, keys) {
  for (const key of keys) if (!options[key]) throw new Error(`missing --${key}`);
}

async function occupiedPublicationDates(prisma) {
  const slots = await prisma.publicationSlot.findMany({
    where: { status: { in: ["SCHEDULED", "HELD", "PUBLISHED"] } },
    select: { publicationDate: true },
  });
  return slots.map((slot) => dateText(slot.publicationDate));
}

async function chooseDate(prisma, options) {
  if (options["publication-date"]) {
    addPacificDays(options["publication-date"], 0);
    return options["publication-date"];
  }
  const start = addPacificDays(pacificDate(new Date()), 1);
  return nextAvailablePacificDate(start, await occupiedPublicationDates(prisma));
}

async function activeSlotOnDate(prisma, publicationDate) {
  return prisma.publicationSlot.findFirst({
    where: {
      publicationDate: new Date(`${publicationDate}T00:00:00.000Z`),
      slotOrder: 1,
      status: { in: ["SCHEDULED", "HELD", "PUBLISHED"] },
    },
    include: { spotVersion: true },
  });
}

let prisma;
try {
  const options = args(process.argv.slice(2));
  required(options, ["envelope", "input", "output", "log", "title", "family", "spot-id", "spot-version-id"]);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  prisma = createPrismaClient(process.env.DATABASE_URL);
  const archiveRoot = resolve(options["archive-root"] ?? process.env.SOLVER_OUTPUTS_DIR ?? "../../SolverOutputs");
  if (options["replace-existing"] && !options["publication-date"]) throw new Error("--replace-existing requires --publication-date YYYY-MM-DD");
  const publicationDate = await chooseDate(prisma, options);
  const occupied = options["publication-date"] ? await activeSlotOnDate(prisma, publicationDate) : null;
  if (occupied && !options["replace-existing"] && occupied.spotVersionId !== options["spot-version-id"]) {
    throw new Error(
      `${publicationDate} slot 1 is already ${occupied.status.toLowerCase()} by ${occupied.spotVersionId}; `
      + "pass --replace-existing to replace it explicitly",
    );
  }

  // A retry of this exact command is safe: a scheduled or published immutable
  // version already has its date, so do not create another template/run or
  // accidentally move it to a later day.
  let version = await prisma.spotVersion.findUnique({ where: { id: options["spot-version-id"] }, include: { publicationSlots: true } });
  if (!version) {
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
  if (occupied && options["replace-existing"] && occupied.spotVersionId !== version.id) {
    if (version.status !== "APPROVED") throw new Error(`replacement version ${version.id} is ${version.status}; expected APPROVED`);
    const replacement = await replacePublishedSlot(prisma, occupied.spotVersionId, version.id, {
      reason: options.reason ?? `operator replaced publication slot ${publicationDate}`,
      actor: options.actor ?? "local-date-replacement",
    });
    const wasPublished = replacement.previousSlotStatus === "PUBLISHED";
    if (wasPublished) await publishPacificDate(prisma, publicationDate, new Date());
    console.log(JSON.stringify({
      action: wasPublished ? "replaced-and-published" : "replaced-and-scheduled",
      spotId: version.spotId,
      oldSpotVersionId: occupied.spotVersionId,
      spotVersionId: version.id,
      publicationDate,
      slotOrder: replacement.slot.slotOrder,
      invalidatedAttempts: replacement.invalidatedAttempts,
      status: wasPublished ? "PUBLISHED" : "SCHEDULED",
    }, null, 2));
  } else if (version.status === "APPROVED") {
    const publicationDate = typeof version.publicPayload?.publicationDate === "string"
      ? version.publicPayload.publicationDate
      : await chooseDate(prisma, options);
    const slot = await scheduleSpotVersion(prisma, version.id, publicationDate, 1);
    const publishNow = publicationDate <= pacificDate(new Date());
    if (publishNow) await publishPacificDate(prisma, publicationDate, new Date());
    console.log(JSON.stringify({ action: publishNow ? "imported-and-published" : "imported-and-scheduled", spotId: version.spotId, spotVersionId: version.id, publicationDate, slotOrder: slot.slotOrder, status: publishNow ? "PUBLISHED" : "SCHEDULED" }, null, 2));
  } else if (version.status === "SCHEDULED" || version.status === "PUBLISHED") {
    const slot = version.publicationSlots.find((item) => ["SCHEDULED", "HELD", "PUBLISHED"].includes(item.status));
    const retryDate = slot ? dateText(slot.publicationDate) : null;
    const publishNow = version.status === "SCHEDULED" && retryDate !== null && retryDate <= pacificDate(new Date());
    if (publishNow) await publishPacificDate(prisma, retryDate, new Date());
    console.log(JSON.stringify({ action: publishNow ? "recovered-and-published" : "already-scheduled", spotId: version.spotId, spotVersionId: version.id, publicationDate: retryDate, slotOrder: slot?.slotOrder ?? null, status: publishNow ? "PUBLISHED" : version.status }, null, 2));
  } else {
    throw new Error(`spot version ${version.id} is ${version.status}; it cannot be automatically scheduled`);
  }
} catch (error) {
  console.error(`spot publish failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
}
