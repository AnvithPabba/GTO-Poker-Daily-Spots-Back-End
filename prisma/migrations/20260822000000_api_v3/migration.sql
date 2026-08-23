CREATE TABLE "GuestIdentity" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestIdentity_pkey" PRIMARY KEY ("id")
);

INSERT INTO "GuestIdentity" ("id", "createdAt")
SELECT "id", "createdAt" FROM "GuestSession";

ALTER TABLE "GuestSession" ADD COLUMN "identityId" TEXT;
UPDATE "GuestSession" SET "identityId" = COALESCE("rotationOfId", "id");
INSERT INTO "GuestIdentity" ("id", "createdAt")
SELECT DISTINCT gs."identityId", MIN(gs."createdAt")
FROM "GuestSession" gs
LEFT JOIN "GuestIdentity" gi ON gi."id" = gs."identityId"
WHERE gi."id" IS NULL
GROUP BY gs."identityId";
ALTER TABLE "GuestSession" ALTER COLUMN "identityId" SET NOT NULL;

ALTER TABLE "Attempt"
  ADD COLUMN "guestIdentityId" TEXT,
  ADD COLUMN "idempotencyPayloadHash" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "similarityBasisPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scorePoints" INTEGER NOT NULL DEFAULT 0;

UPDATE "Attempt" a
SET "guestIdentityId" = gs."identityId",
    "similarityBasisPoints" = ROUND(a."overallSimilarity" * 100),
    "scorePoints" = ROUND(a."overallSimilarity" * 10)
FROM "GuestSession" gs
WHERE a."guestSessionId" = gs."id";

ALTER TABLE "GuestSession" ADD CONSTRAINT "GuestSession_identityId_fkey"
  FOREIGN KEY ("identityId") REFERENCES "GuestIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_guestIdentityId_fkey"
  FOREIGN KEY ("guestIdentityId") REFERENCES "GuestIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "GuestSession_identityId_createdAt_idx" ON "GuestSession"("identityId", "createdAt");
CREATE INDEX "Attempt_guestIdentityId_createdAt_idx" ON "Attempt"("guestIdentityId", "createdAt");
CREATE UNIQUE INDEX "Attempt_guestIdentityId_spotVersionId_idempotencyKey_key"
  ON "Attempt"("guestIdentityId", "spotVersionId", "idempotencyKey");
CREATE UNIQUE INDEX "Attempt_guest_official_once_idx"
  ON "Attempt"("guestIdentityId", "spotVersionId")
  WHERE "official" = TRUE AND "guestIdentityId" IS NOT NULL;
CREATE UNIQUE INDEX "Attempt_account_official_once_idx"
  ON "Attempt"("accountId", "spotVersionId")
  WHERE "official" = TRUE AND "accountId" IS NOT NULL;

ALTER TABLE "SpotVersion" ALTER COLUMN "schemaVersion" SET DEFAULT 3;
