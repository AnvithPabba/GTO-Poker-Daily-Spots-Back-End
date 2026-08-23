-- Preserve historical attempts while allowing invalid solver versions to be
-- removed from user-facing progress and statistics.
CREATE TYPE "AttemptValidity" AS ENUM ('VALID', 'INVALIDATED');

ALTER TABLE "Attempt"
  ADD COLUMN "validity" "AttemptValidity" NOT NULL DEFAULT 'VALID',
  ADD COLUMN "invalidatedAt" TIMESTAMP(3),
  ADD COLUMN "invalidationReason" TEXT,
  ADD COLUMN "replacementSpotVersionId" TEXT;

CREATE INDEX "Attempt_validity_createdAt_idx" ON "Attempt"("validity", "createdAt");
