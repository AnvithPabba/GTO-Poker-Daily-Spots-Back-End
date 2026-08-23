#!/usr/bin/env node
import { resolve } from "node:path";
import { createPrismaClient } from "../dist/db.js";
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

const options = args(process.argv.slice(2));
for (const required of ["envelope", "input", "output", "log", "title"]) {
  if (!options[required]) throw new Error(`missing --${required}`);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const prisma = createPrismaClient(process.env.DATABASE_URL);
const archiveRoot = resolve(options["archive-root"] ?? process.env.SOLVER_OUTPUTS_DIR ?? "../../SolverOutputs");

try {
  const familyId = options.family ?? `manual-${Date.now()}`;
  const result = await ingestSpot(prisma, {
    envelopePath: options.envelope,
    inputPath: options.input,
    outputPath: options.output,
    logPath: options.log,
    ...(options.provenance ? { provenancePath: options.provenance } : {}),
    archiveRoot,
    title: options.title,
    familyId,
    ...(options["template-name"] ? { templateName: options["template-name"] } : {}),
    ...(options.seed ? { seed: options.seed } : {}),
    ...(options["spot-id"] ? { spotId: options["spot-id"] } : {}),
    ...(options["spot-version-id"] ? { spotVersionId: options["spot-version-id"] } : {}),
    ...(options["publication-date"] ? { publicationDate: options["publication-date"] } : {}),
    ...(options["slot-order"] ? { slotOrder: Number(options["slot-order"]) } : {}),
    ...(options["initial-actor"] ? { initialActor: options["initial-actor"] } : {}),
  });
  console.log(JSON.stringify({ templateId: result.templateId, jobId: result.jobId, solverRunId: result.solverRunId, spotId: result.spotId, spotVersionId: result.spotVersionId, status: result.status }, null, 2));
} finally {
  await prisma.$disconnect();
}
