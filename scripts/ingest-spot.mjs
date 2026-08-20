#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrismaClient } from "../dist/db.js";
import { createSolverTemplate } from "../dist/solver/template.js";
import { archiveRun, verifyArchive } from "../dist/solver/archive.js";
import { persistValidatedDraft } from "../dist/solver/pipeline.js";
import { normalizeProviderEnvelope } from "../dist/solver/provider.js";

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
for (const required of ["envelope", "input", "output", "log", "title", "config"]) {
  if (!options[required]) throw new Error(`missing --${required}`);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const readJson = async (file) => JSON.parse(await readFile(resolve(file), "utf8"));
const read = async (file) => readFile(resolve(file));
const prisma = createPrismaClient(process.env.DATABASE_URL);
const archiveRoot = resolve(options["archive-root"] ?? process.env.SOLVER_OUTPUTS_DIR ?? "../../SolverOutputs");

try {
  const config = await readJson(options.config);
  const familyId = options.family ?? `manual-${Date.now()}`;
  const latest = await prisma.solverTemplate.findFirst({ where: { familyId }, orderBy: { version: "desc" }, select: { version: true } });
  const template = await createSolverTemplate(prisma, { familyId, version: (latest?.version ?? 0) + 1, name: options["template-name"] ?? options.title, config });
  const job = await prisma.solverJob.create({ data: { templateId: template.id, effectiveSeed: options.seed ?? `${familyId}:${template.version}` } });
  const input = await read(options.input);
  const output = await read(options.output);
  const log = await read(options.log);
  const archived = await archiveRun(archiveRoot, [
    { name: "input.txt", content: input },
    { name: "output_result.json", content: output },
    { name: "solver.log", content: log },
  ]);
  const archivedWithMetadata = await archiveRun(archiveRoot, [
    { name: "input.txt", content: input },
    { name: "output_result.json", content: output },
    { name: "solver.log", content: log },
    { name: "metadata.json", content: JSON.stringify({ sourceHash: archived.sourceHash, templateId: template.id, jobId: job.id }, null, 2) },
  ]);
  await verifyArchive(archiveRoot, archivedWithMetadata);
  const envelope = normalizeProviderEnvelope(await readJson(options.envelope), {
    ...(options["spot-id"] ? { spotId: options["spot-id"] } : {}),
    ...(options["spot-version-id"] ? { spotVersionId: options["spot-version-id"] } : {}),
    ...(options["publication-date"] ? { publicationDate: options["publication-date"] } : {}),
    ...(options["slot-order"] ? { slotOrder: Number(options["slot-order"]) } : {}),
    ...(options["initial-actor"] ? { initialActor: options["initial-actor"] } : {}),
  });
  const result = await persistValidatedDraft(prisma, {
    jobId: job.id,
    attemptNumber: 1,
    resolvedInput: config,
    inputSha256: archived.artifacts["input.txt"].sha256,
    outputSha256: archived.artifacts["output_result.json"].sha256,
    logSha256: archived.artifacts["solver.log"].sha256,
    archiveInputKey: archived.artifacts["input.txt"].key,
    archiveOutputKey: archived.artifacts["output_result.json"].key,
    archiveLogKey: archived.artifacts["solver.log"].key,
    archiveMetadataKey: `solver-runs/sha256/${archived.sourceHash}/metadata.json`,
  }, envelope, { title: options.title });
  console.log(JSON.stringify({ templateId: template.id, jobId: job.id, solverRunId: result.run.id, spotId: result.spot.id, spotVersionId: result.version.id, status: result.version.status }, null, 2));
} finally {
  await prisma.$disconnect();
}
