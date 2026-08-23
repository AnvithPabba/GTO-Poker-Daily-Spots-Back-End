import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

import { archiveRun, verifyArchive, type ArchivedRun } from "./archive.js";
import { assertImportProvenance } from "./import-provenance.js";
import { normalizeProviderEnvelope } from "./provider.js";
import { createSolverTemplate } from "./template.js";
import { persistValidatedDraft } from "./pipeline.js";

export type IngestSpotOptions = {
  envelopePath: string;
  inputPath: string;
  outputPath: string;
  logPath: string;
  provenancePath?: string;
  archiveRoot: string;
  title: string;
  familyId: string;
  templateName?: string;
  seed?: string;
  spotId?: string;
  spotVersionId?: string;
  publicationDate?: string;
  slotOrder?: number;
  initialActor?: "ip" | "oop";
};

export type IngestSpotResult = {
  templateId: string;
  jobId: string;
  solverRunId: string;
  spotId: string;
  spotVersionId: string;
  status: string;
  version: number;
  archive: ArchivedRun;
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

/**
 * Import one private provider envelope through the same validated boundary as
 * the operator CLI.  This function intentionally has no HTTP concerns: it is
 * called by local authoring scripts, while normal API requests only read the
 * immutable rows created here.
 */
export async function ingestSpot(prisma: PrismaClient, options: IngestSpotOptions): Promise<IngestSpotResult> {
  const inputPath = resolve(options.inputPath);
  const outputPath = resolve(options.outputPath);
  const logPath = resolve(options.logPath);
  const envelopePath = resolve(options.envelopePath);
  const provenancePath = resolve(options.provenancePath ?? `${dirname(inputPath)}/configuration.json`);
  const provenance = await readJson(provenancePath) as Record<string, unknown>;
  const config = provenance.authoredConfig ?? provenance;
  const input = await readFile(inputPath);
  const output = await readFile(outputPath);
  const log = await readFile(logPath);
  const rawEnvelope = await readJson(envelopePath);

  assertImportProvenance(rawEnvelope, provenance, input.toString("utf8"));

  const latest = await prisma.solverTemplate.findFirst({ where: { familyId: options.familyId }, orderBy: { version: "desc" }, select: { version: true } });
  const template = await createSolverTemplate(prisma, {
    familyId: options.familyId,
    version: (latest?.version ?? 0) + 1,
    name: options.templateName ?? options.title,
    config,
    ...(options.seed !== undefined ? { defaultSeed: options.seed } : {}),
  });
  const job = await prisma.solverJob.create({ data: { templateId: template.id, effectiveSeed: options.seed ?? `${options.familyId}:${template.version}` } });

  const archived = await archiveRun(options.archiveRoot, [
    { name: "input.txt", content: input },
    { name: "output_result.json", content: output },
    { name: "solver.log", content: log },
  ]);
  const archivedWithMetadata = await archiveRun(options.archiveRoot, [
    { name: "input.txt", content: input },
    { name: "output_result.json", content: output },
    { name: "solver.log", content: log },
    { name: "metadata.json", content: JSON.stringify({ sourceHash: archived.sourceHash, templateId: template.id, jobId: job.id }, null, 2) },
  ]);
  await verifyArchive(options.archiveRoot, archivedWithMetadata);

  const envelope = normalizeProviderEnvelope(rawEnvelope, {
    ...(options.spotId ? { spotId: options.spotId } : {}),
    ...(options.spotVersionId ? { spotVersionId: options.spotVersionId } : {}),
    ...(options.publicationDate ? { publicationDate: options.publicationDate } : {}),
    ...(options.slotOrder !== undefined ? { slotOrder: options.slotOrder } : {}),
    ...(options.initialActor ? { initialActor: options.initialActor } : {}),
  });
  const result = await persistValidatedDraft(prisma, {
    jobId: job.id,
    attemptNumber: 1,
    resolvedInput: provenance,
    inputSha256: archived.artifacts["input.txt"].sha256,
    outputSha256: archived.artifacts["output_result.json"].sha256,
    logSha256: archived.artifacts["solver.log"].sha256,
    archiveInputKey: archived.artifacts["input.txt"].key,
    archiveOutputKey: archived.artifacts["output_result.json"].key,
    archiveLogKey: archived.artifacts["solver.log"].key,
    archiveMetadataKey: `solver-runs/sha256/${archived.sourceHash}/metadata.json`,
  }, envelope, { title: options.title });

  return {
    templateId: template.id,
    jobId: job.id,
    solverRunId: result.run.id,
    spotId: result.spot.id,
    spotVersionId: result.version.id,
    status: result.version.status,
    version: result.version.version,
    archive: archivedWithMetadata,
  };
}
