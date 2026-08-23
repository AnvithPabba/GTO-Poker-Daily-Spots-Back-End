import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

import { archiveRun, verifyArchive, type ArchivedRun } from "./archive.js";
import { assertImportProvenance } from "./import-provenance.js";
import { normalizeProviderEnvelope } from "./provider.js";
import { createSolverTemplate } from "./template.js";
import { persistValidatedDraft } from "./pipeline.js";
import { assertPublishableStrategyQuality } from "./normalized.js";
import { assessSolverLog, SolverQualityError, type SolverQualityReport } from "./quality.js";

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

async function readArtifact(path: string): Promise<{ content: Buffer; missing: boolean }> {
  try {
    return { content: await readFile(path), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: Buffer.alloc(0), missing: true };
    throw error;
  }
}

const MAX_IN_MEMORY_OUTPUT_JSON_BYTES = 64 * 1024 * 1024;

/**
 * Validate the native solver artifact without turning a potentially very large
 * tree into one JavaScript string.  Native TexasSolver dumps can be hundreds
 * of megabytes; the normalized provider envelope is the data we actually
 * interpret, while this check still rejects malformed small fixtures and
 * obviously non-object large artifacts before they enter the database.
 */
function assertSolverOutputJson(content: Uint8Array): void {
  if (content.byteLength <= MAX_IN_MEMORY_OUTPUT_JSON_BYTES) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(content).toString("utf8"));
    } catch (error) {
      throw new SolverQualityError(`solver output is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SolverQualityError("solver output must be a JSON object");
    }
    return;
  }

  let start = 0;
  let end = content.byteLength - 1;
  const isWhitespace = (value: number): boolean => value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
  while (start <= end && isWhitespace(content[start] ?? -1)) start += 1;
  while (end >= start && isWhitespace(content[end] ?? -1)) end -= 1;
  if (start > end || content[start] !== 0x7b || content[end] !== 0x7d) {
    throw new SolverQualityError("solver output is malformed JSON object");
  }
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
  const [provenanceResult, inputResult, outputResult, logResult] = await Promise.all([
    readJson(provenancePath).then((value) => ({ value: value as Record<string, unknown>, error: undefined })).catch((error: unknown) => ({ value: undefined, error })),
    readArtifact(inputPath),
    readArtifact(outputPath),
    readArtifact(logPath),
  ]);
  const provenance = provenanceResult.value;
  const config = provenance?.authoredConfig ?? provenance;
  const input = inputResult.content;
  const output = outputResult.content;
  const log = logResult.content;
  // Read the provider envelope as bytes before any validation.  Keeping this
  // in the same artifact path as the native files means missing/malformed
  // envelopes are archived and reported just like missing solver output.
  const envelopeResult = await readArtifact(envelopePath);
  const envelopeBytes = envelopeResult.content;
  const missingArtifacts = [
    ...(provenanceResult.error ? ["configuration.json"] : []),
    ...(envelopeResult.missing ? ["provider-envelope.json"] : []),
    ...(inputResult.missing ? ["input.txt"] : []),
    ...(outputResult.missing ? ["output_result.json"] : []),
    ...(logResult.missing ? ["solver.log"] : []),
  ];
  // Archive source artifacts before any quality gate.  A rejected solve must
  // remain available for diagnosis, but must not create a template, job, or
  // SpotVersion row.
  const archived = await archiveRun(options.archiveRoot, [
    { name: "input.txt", content: input },
    { name: "output_result.json", content: output },
    { name: "solver.log", content: log },
  ]);
  const authoredConfig = provenance?.authoredConfig;
  const authoredConfigObject = authoredConfig && typeof authoredConfig === "object"
    ? authoredConfig as Record<string, unknown>
    : undefined;
  const solverSettings = authoredConfigObject?.solver && typeof authoredConfigObject.solver === "object"
    ? authoredConfigObject.solver as Record<string, unknown>
    : undefined;
  let rawEnvelope: unknown;
  let envelope: ReturnType<typeof normalizeProviderEnvelope>;
  let qualityReport: SolverQualityReport;
  try {
    if (missingArtifacts.length) {
      throw new SolverQualityError(`required solver artifact is missing: ${missingArtifacts.join(", ")}`);
    }
    try {
      rawEnvelope = JSON.parse(envelopeBytes.toString("utf8"));
    } catch (error) {
      throw new SolverQualityError(`provider envelope is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertSolverOutputJson(output);
    assertImportProvenance(rawEnvelope, provenance!, input.toString("utf8"));
    if (!solverSettings || typeof solverSettings.minimum_iterations !== "number" || typeof solverSettings.accuracy_percent !== "number") {
      throw new SolverQualityError("configuration provenance is missing solver quality settings");
    }
    qualityReport = assessSolverLog(log.toString("utf8"), {
      minimumIterations: solverSettings.minimum_iterations,
      accuracyPercent: solverSettings.accuracy_percent,
    });
    envelope = normalizeProviderEnvelope(rawEnvelope, {
      ...(options.spotId ? { spotId: options.spotId } : {}),
      ...(options.spotVersionId ? { spotVersionId: options.spotVersionId } : {}),
      ...(options.publicationDate ? { publicationDate: options.publicationDate } : {}),
      ...(options.slotOrder !== undefined ? { slotOrder: options.slotOrder } : {}),
      ...(options.initialActor ? { initialActor: options.initialActor } : {}),
    });
    assertPublishableStrategyQuality(envelope);
  } catch (error) {
    const report = error instanceof SolverQualityError ? error.report : undefined;
    const rejectedArchive = await archiveRun(options.archiveRoot, [
      { name: "input.txt", content: input },
      { name: "output_result.json", content: output },
      { name: "solver.log", content: log },
      { name: "metadata.json", content: JSON.stringify({
        sourceHash: archived.sourceHash,
        rejected: true,
        rejectionReason: error instanceof Error ? error.message : String(error),
        qualityReport: report ?? null,
        missingArtifacts,
        rejectedAt: new Date().toISOString(),
      }, null, 2) },
    ]);
    await verifyArchive(options.archiveRoot, rejectedArchive);
    throw error;
  }

  const latest = await prisma.solverTemplate.findFirst({ where: { familyId: options.familyId }, orderBy: { version: "desc" }, select: { version: true } });
  const template = await createSolverTemplate(prisma, {
    familyId: options.familyId,
    version: (latest?.version ?? 0) + 1,
    name: options.templateName ?? options.title,
    config,
    ...(options.seed !== undefined ? { defaultSeed: options.seed } : {}),
  });
  const job = await prisma.solverJob.create({ data: { templateId: template.id, effectiveSeed: options.seed ?? `${options.familyId}:${template.version}` } });

  const archivedWithMetadata = await archiveRun(options.archiveRoot, [
    { name: "input.txt", content: input },
    { name: "output_result.json", content: output },
    { name: "solver.log", content: log },
    { name: "metadata.json", content: JSON.stringify({ sourceHash: archived.sourceHash, templateId: template.id, jobId: job.id }, null, 2) },
  ]);
  await verifyArchive(options.archiveRoot, archivedWithMetadata);

  const result = await persistValidatedDraft(prisma, {
    jobId: job.id,
    attemptNumber: 1,
    resolvedInput: provenance!,
    inputSha256: archived.artifacts["input.txt"].sha256,
    outputSha256: archived.artifacts["output_result.json"].sha256,
    logSha256: archived.artifacts["solver.log"].sha256,
    archiveInputKey: archived.artifacts["input.txt"].key,
    archiveOutputKey: archived.artifacts["output_result.json"].key,
    archiveLogKey: archived.artifacts["solver.log"].key,
    archiveMetadataKey: archivedWithMetadata.artifacts["metadata.json"].key,
    qualityReport,
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
