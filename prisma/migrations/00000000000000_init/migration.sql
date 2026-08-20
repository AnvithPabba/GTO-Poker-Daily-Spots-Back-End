-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SolverTemplateStatus" AS ENUM ('ACTIVE', 'HELD', 'RETIRED');

-- CreateEnum
CREATE TYPE "SolverJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SolverRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SpotMode" AS ENUM ('SINGLE_HAND', 'MULTI_HAND');

-- CreateEnum
CREATE TYPE "SpotStatus" AS ENUM ('DRAFT', 'APPROVED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpotVersionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PublicationSlotStatus" AS ENUM ('SCHEDULED', 'HELD', 'PUBLISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SolverTemplate" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tags" JSONB,
    "status" "SolverTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB NOT NULL,
    "configSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "selectionRankingVersion" TEXT NOT NULL DEFAULT '1',
    "defaultSeed" TEXT,
    "supersedesTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolverTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolverJob" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "effectiveSeed" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "SolverJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "pgBossJobId" TEXT,
    "successfulRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolverJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolverRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "SolverRunStatus" NOT NULL DEFAULT 'RUNNING',
    "solverVersion" TEXT,
    "platform" TEXT,
    "resolvedInput" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "exitCode" INTEGER,
    "logTail" TEXT,
    "sourceHash" TEXT,
    "inputSha256" TEXT,
    "outputSha256" TEXT,
    "logSha256" TEXT,
    "archiveInputKey" TEXT,
    "archiveOutputKey" TEXT,
    "archiveLogKey" TEXT,
    "archiveMetadataKey" TEXT,
    "archiveVerifiedAt" TIMESTAMP(3),
    "normalizerVersion" TEXT,
    "selectionRankingVersion" TEXT,
    "failureDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolverRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Spot" (
    "id" TEXT NOT NULL,
    "mode" "SpotMode" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" JSONB,
    "status" "SpotStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Spot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpotVersion" (
    "id" TEXT NOT NULL,
    "spotId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "solverRunId" TEXT NOT NULL,
    "candidateManifest" JSONB NOT NULL,
    "publicPayload" JSONB NOT NULL,
    "privateSolutionPayload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "normalizerVersion" TEXT NOT NULL,
    "selectionRankingVersion" TEXT NOT NULL,
    "publicPayloadSha256" TEXT NOT NULL,
    "privatePayloadSha256" TEXT NOT NULL,
    "validationReport" JSONB,
    "status" "SpotVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "SpotVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationSlot" (
    "id" TEXT NOT NULL,
    "publicationDate" DATE NOT NULL,
    "slotOrder" INTEGER NOT NULL,
    "spotVersionId" TEXT NOT NULL,
    "status" "PublicationSlotStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "heldAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicationSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotationOfId" TEXT,
    "abuseMetadata" JSONB,

    CONSTRAINT "GuestSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "guestSessionId" TEXT NOT NULL,
    "spotId" TEXT NOT NULL,
    "spotVersionId" TEXT NOT NULL,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "practiceOrdinal" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "submittedPayload" JSONB NOT NULL,
    "resultPayload" JSONB NOT NULL,
    "overallSimilarity" DOUBLE PRECISION NOT NULL,
    "metricKey" TEXT NOT NULL,
    "metricVersion" INTEGER NOT NULL,
    "aggregatorKey" TEXT NOT NULL,
    "aggregatorVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestMetadata" JSONB,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SolverTemplate_status_familyId_idx" ON "SolverTemplate"("status", "familyId");

-- CreateIndex
CREATE UNIQUE INDEX "SolverTemplate_familyId_version_key" ON "SolverTemplate"("familyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SolverJob_successfulRunId_key" ON "SolverJob"("successfulRunId");

-- CreateIndex
CREATE INDEX "SolverJob_status_nextAttemptAt_priority_createdAt_idx" ON "SolverJob"("status", "nextAttemptAt", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "SolverJob_templateId_createdAt_idx" ON "SolverJob"("templateId", "createdAt");

-- CreateIndex
CREATE INDEX "SolverRun_status_createdAt_idx" ON "SolverRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SolverRun_sourceHash_idx" ON "SolverRun"("sourceHash");

-- CreateIndex
CREATE UNIQUE INDEX "SolverRun_jobId_attemptNumber_key" ON "SolverRun"("jobId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SolverRun_outputSha256_key" ON "SolverRun"("outputSha256");

-- CreateIndex
CREATE UNIQUE INDEX "Spot_currentVersionId_key" ON "Spot"("currentVersionId");

-- CreateIndex
CREATE INDEX "Spot_status_updatedAt_idx" ON "Spot"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SpotVersion_status_createdAt_idx" ON "SpotVersion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SpotVersion_spotId_status_idx" ON "SpotVersion"("spotId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SpotVersion_spotId_version_key" ON "SpotVersion"("spotId", "version");

-- CreateIndex
CREATE INDEX "PublicationSlot_status_publicationDate_slotOrder_idx" ON "PublicationSlot"("status", "publicationDate", "slotOrder");

-- CreateIndex
CREATE INDEX "PublicationSlot_spotVersionId_status_idx" ON "PublicationSlot"("spotVersionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GuestSession_tokenHash_key" ON "GuestSession"("tokenHash");

-- CreateIndex
CREATE INDEX "GuestSession_expiresAt_revokedAt_idx" ON "GuestSession"("expiresAt", "revokedAt");

-- CreateIndex
CREATE INDEX "Attempt_guestSessionId_createdAt_idx" ON "Attempt"("guestSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "Attempt_spotVersionId_createdAt_idx" ON "Attempt"("spotVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "Attempt_spotId_createdAt_idx" ON "Attempt"("spotId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_guestSessionId_spotVersionId_idempotencyKey_key" ON "Attempt"("guestSessionId", "spotVersionId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "SolverJob" ADD CONSTRAINT "SolverJob_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SolverTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolverJob" ADD CONSTRAINT "SolverJob_successfulRunId_fkey" FOREIGN KEY ("successfulRunId") REFERENCES "SolverRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolverRun" ADD CONSTRAINT "SolverRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SolverJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Spot" ADD CONSTRAINT "Spot_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "SpotVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotVersion" ADD CONSTRAINT "SpotVersion_spotId_fkey" FOREIGN KEY ("spotId") REFERENCES "Spot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotVersion" ADD CONSTRAINT "SpotVersion_solverRunId_fkey" FOREIGN KEY ("solverRunId") REFERENCES "SolverRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationSlot" ADD CONSTRAINT "PublicationSlot_spotVersionId_fkey" FOREIGN KEY ("spotVersionId") REFERENCES "SpotVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_guestSessionId_fkey" FOREIGN KEY ("guestSessionId") REFERENCES "GuestSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_spotId_fkey" FOREIGN KEY ("spotId") REFERENCES "Spot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_spotVersionId_fkey" FOREIGN KEY ("spotVersionId") REFERENCES "SpotVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only one active slot may occupy a Pacific date/order or version. Historical
-- cancelled slots remain auditable without blocking rescheduling.
CREATE UNIQUE INDEX "PublicationSlot_active_date_order_key"
  ON "PublicationSlot" ("publicationDate", "slotOrder")
  WHERE "status" IN ('SCHEDULED', 'HELD', 'PUBLISHED');
CREATE UNIQUE INDEX "PublicationSlot_active_version_key"
  ON "PublicationSlot" ("spotVersionId")
  WHERE "status" IN ('SCHEDULED', 'HELD', 'PUBLISHED');

-- A guest can have exactly one official result for an immutable version.
CREATE UNIQUE INDEX "Attempt_one_official_per_guest_version_key"
  ON "Attempt" ("guestSessionId", "spotVersionId")
  WHERE "official" = TRUE;

-- Spot versions are immutable once inserted. Lifecycle metadata may advance,
-- but poker content, provenance, and payload hashes cannot be rewritten.
CREATE OR REPLACE FUNCTION prevent_spot_version_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."spotId" IS DISTINCT FROM OLD."spotId"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."solverRunId" IS DISTINCT FROM OLD."solverRunId"
     OR NEW."candidateManifest" IS DISTINCT FROM OLD."candidateManifest"
     OR NEW."publicPayload" IS DISTINCT FROM OLD."publicPayload"
     OR NEW."privateSolutionPayload" IS DISTINCT FROM OLD."privateSolutionPayload"
     OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."normalizerVersion" IS DISTINCT FROM OLD."normalizerVersion"
     OR NEW."selectionRankingVersion" IS DISTINCT FROM OLD."selectionRankingVersion"
     OR NEW."publicPayloadSha256" IS DISTINCT FROM OLD."publicPayloadSha256"
     OR NEW."privatePayloadSha256" IS DISTINCT FROM OLD."privatePayloadSha256"
  THEN
    RAISE EXCEPTION 'SpotVersion content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SpotVersion_content_immutable"
  BEFORE UPDATE ON "SpotVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_spot_version_content_update();
