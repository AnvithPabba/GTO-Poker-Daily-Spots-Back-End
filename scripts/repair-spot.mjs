#!/usr/bin/env node
/**
 * Import a validated replacement version, supersede the bad published
 * version, invalidate its attempts, and publish into the same Pacific slot.
 * The operation is idempotent up to the immutable new version id.
 */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createPrismaClient } from "../dist/db.js";
import { approveSpotVersion, publishPacificDate, replacePublishedSlot } from "../dist/publication.js";
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

function required(options, keys) {
  for (const key of keys) if (!options[key]) throw new Error(`missing --${key}`);
}

function dateText(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function rawStrategySignatures(envelope) {
  const strategy = envelope?.privateSolutionPayload?.strategy;
  const actionOrder = Array.isArray(strategy?.actionOrder) ? strategy.actionOrder.map(String) : [];
  const byCombo = strategy?.byCombo;
  if (!actionOrder.length || !byCombo || typeof byCombo !== "object") throw new Error("replacement envelope is missing private strategy data");
  return Object.values(byCombo).map((entry) => {
    const frequencies = entry && typeof entry === "object" && entry.frequencies && typeof entry.frequencies === "object" ? entry.frequencies : {};
    const values = actionOrder.map((id) => Number(frequencies[id] ?? 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    const scale = Math.abs(total - 1) < 1e-6 ? 10_000 : 1;
    return values.map((value) => Math.round(value * scale)).join(",");
  });
}

async function assertRepairCandidateIsNotUniform(envelopePath) {
  const envelope = JSON.parse(await readFile(resolve(envelopePath), "utf8"));
  const signatures = rawStrategySignatures(envelope);
  if (signatures.length > 1 && new Set(signatures).size === 1) {
    throw new Error("replacement candidate has one identical strategy vector for every combo; refuse publication");
  }
}

const options = args(process.argv.slice(2));
required(options, ["envelope", "input", "output", "log", "title", "family", "old-version-id", "new-version-id"]);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const prisma = createPrismaClient(process.env.DATABASE_URL);
const archiveRoot = resolve(options["archive-root"] ?? process.env.SOLVER_OUTPUTS_DIR ?? "../../SolverOutputs");
const reason = options.reason ?? "published solver version failed quality validation";
const actor = options.actor ?? "local-repair";

try {
  const oldVersion = await prisma.spotVersion.findUnique({
    where: { id: options["old-version-id"] },
    include: { publicationSlots: { where: { status: "PUBLISHED" }, orderBy: { publicationDate: "desc" } } },
  });
  if (!oldVersion) throw new Error(`old version not found: ${options["old-version-id"]}`);
  const spotId = options["spot-id"] ?? oldVersion.spotId;
  if (oldVersion.spotId !== spotId) throw new Error("--spot-id does not match the old version");
  const oldSlot = oldVersion.publicationSlots[0];
  if (!oldSlot) throw new Error("old version has no published slot");

  let version = await prisma.spotVersion.findUnique({ where: { id: options["new-version-id"] } });
  if (!version) {
    await assertRepairCandidateIsNotUniform(options.envelope);
    const imported = await ingestSpot(prisma, {
      envelopePath: options.envelope,
      inputPath: options.input,
      outputPath: options.output,
      logPath: options.log,
      ...(options.provenance ? { provenancePath: options.provenance } : {}),
      archiveRoot,
      title: options.title,
      familyId: options.family,
      spotId,
      spotVersionId: options["new-version-id"],
      publicationDate: dateText(oldSlot.publicationDate),
      slotOrder: oldSlot.slotOrder,
      ...(options.seed ? { seed: options.seed } : {}),
      ...(options["initial-actor"] ? { initialActor: options["initial-actor"] } : {}),
    });
    version = await prisma.spotVersion.findUniqueOrThrow({ where: { id: imported.spotVersionId } });
  }
  {
    const report = version.validationReport && typeof version.validationReport === "object" ? version.validationReport : null;
    const diversity = report && typeof report === "object" ? report.strategyDiversity : undefined;
    if (diversity && typeof diversity === "object" && diversity.uniformAcrossCombos === true) {
      throw new Error("replacement version has a uniform strategy vector; refuse publication");
    }
  }
  if (version.spotId !== oldVersion.spotId) throw new Error("replacement version belongs to a different spot");
  if (version.status === "VALIDATED") version = await approveSpotVersion(prisma, version.id);
  if (version.status !== "APPROVED") throw new Error(`replacement version is ${version.status}; expected APPROVED`);

  const replacement = await replacePublishedSlot(prisma, oldVersion.id, version.id, { reason, actor });
  const published = await publishPacificDate(prisma, dateText(replacement.slot.publicationDate), new Date());
  console.log(JSON.stringify({
    action: "repaired-and-published",
    spotId: oldVersion.spotId,
    oldVersionId: oldVersion.id,
    newVersionId: version.id,
    publicationDate: dateText(replacement.slot.publicationDate),
    slotOrder: replacement.slot.slotOrder,
    invalidatedAttempts: replacement.invalidatedAttempts,
    publishedSlots: published.length,
    reason,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
