import { Prisma, SolverJobStatus, SolverRunStatus, SpotStatus, SpotVersionStatus, type PrismaClient } from "@prisma/client";
import { payloadSha256, validateNormalizedEnvelope, type NormalizedEnvelope } from "./normalized.js";

export type PersistRunInput = {
  jobId: string;
  attemptNumber: number;
  resolvedInput: unknown;
  solverVersion?: string;
  platform?: string;
  inputSha256?: string;
  outputSha256?: string;
  logSha256?: string;
  archiveInputKey?: string;
  archiveOutputKey?: string;
  archiveLogKey?: string;
  archiveMetadataKey?: string;
  logTail?: string;
  exitCode?: number;
  durationMs?: number;
};

export async function persistValidatedDraft(
  prisma: PrismaClient,
  input: PersistRunInput,
  rawEnvelope: unknown,
  spotMetadata: { title: string; description?: string; tags?: unknown },
) {
  const envelope = validateNormalizedEnvelope(rawEnvelope);
  const result = await prisma.$transaction(async (tx) => {
    const publicHash = payloadSha256(envelope.publicPayload);
    const privateHash = payloadSha256(envelope.privateSolutionPayload);
    const existingVersion = await tx.spotVersion.findUnique({ where: { id: envelope.publicPayload.spotVersionId }, include: { spot: true, solverRun: true } });
    if (existingVersion) {
      if (existingVersion.publicPayloadSha256 !== publicHash || existingVersion.privatePayloadSha256 !== privateHash) {
        throw new Error(`spot version ${existingVersion.id} already exists with different content`);
      }
      // The immutable run already belongs to the original successful job;
      // `successfulRunId` is intentionally unique, so an idempotent replay
      // job records success without stealing/reusing that relationship.
      await tx.solverJob.update({ where: { id: input.jobId }, data: { status: SolverJobStatus.SUCCEEDED, attemptCount: input.attemptNumber, finishedAt: new Date() } });
      return { run: existingVersion.solverRun, spot: existingVersion.spot, version: existingVersion };
    }
    const run = await tx.solverRun.create({
      data: {
        jobId: input.jobId,
        attemptNumber: input.attemptNumber,
        status: SolverRunStatus.SUCCEEDED,
        solverVersion: input.solverVersion ?? null,
        platform: input.platform ?? null,
        resolvedInput: input.resolvedInput as Prisma.InputJsonValue,
        finishedAt: new Date(),
        durationMs: input.durationMs ?? null,
        exitCode: input.exitCode ?? 0,
        logTail: input.logTail ?? null,
        sourceHash: envelope.sourceHash,
        inputSha256: input.inputSha256 ?? null,
        outputSha256: input.outputSha256 ?? null,
        logSha256: input.logSha256 ?? null,
        archiveInputKey: input.archiveInputKey ?? null,
        archiveOutputKey: input.archiveOutputKey ?? null,
        archiveLogKey: input.archiveLogKey ?? null,
        archiveMetadataKey: input.archiveMetadataKey ?? null,
        archiveVerifiedAt: new Date(),
        normalizerVersion: envelope.provenance.normalizerVersion,
        selectionRankingVersion: envelope.provenance.selectionRankingVersion,
      },
    });
    const existingSpot = await tx.spot.findUnique({ where: { id: envelope.publicPayload.spotId } });
    const spot = existingSpot ?? await tx.spot.create({
      data: {
        id: envelope.publicPayload.spotId,
        title: spotMetadata.title,
        description: spotMetadata.description ?? null,
        ...(spotMetadata.tags !== undefined ? { tags: spotMetadata.tags as Prisma.InputJsonValue } : {}),
        status: SpotStatus.DRAFT,
      },
    });
    const latestVersion = await tx.spotVersion.findFirst({ where: { spotId: spot.id }, orderBy: { version: "desc" }, select: { version: true } });
    const version = await tx.spotVersion.create({
      data: {
        id: envelope.publicPayload.spotVersionId,
        spotId: spot.id,
        version: (latestVersion?.version ?? 0) + 1,
        solverRunId: run.id,
        candidateManifest: envelope.candidateManifest as Prisma.InputJsonValue,
        publicPayload: envelope.publicPayload as Prisma.InputJsonValue,
        privateSolutionPayload: envelope.privateSolutionPayload as Prisma.InputJsonValue,
        schemaVersion: envelope.schemaVersion,
        normalizerVersion: envelope.provenance.normalizerVersion,
        selectionRankingVersion: envelope.provenance.selectionRankingVersion,
        publicPayloadSha256: publicHash,
        privatePayloadSha256: privateHash,
        validationReport: { valid: true, validatedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        status: SpotVersionStatus.VALIDATED,
        validatedAt: new Date(),
      },
    });
    await tx.solverJob.update({ where: { id: input.jobId }, data: { status: SolverJobStatus.SUCCEEDED, attemptCount: input.attemptNumber, finishedAt: new Date(), successfulRunId: run.id } });
    return { run, spot, version };
  });
  return result;
}
