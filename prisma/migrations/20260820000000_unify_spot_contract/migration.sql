-- Block 7A: public spots no longer have separate single/multi-hand modes.
-- The immutable public payload now always contains a featured combo and a
-- selectable concrete-combo catalog. Existing rows retain that data in JSONB.
ALTER TABLE "Spot" DROP COLUMN IF EXISTS "mode";
DROP TYPE IF EXISTS "SpotMode";

ALTER TABLE "SpotVersion" ALTER COLUMN "schemaVersion" SET DEFAULT 2;

CREATE UNIQUE INDEX IF NOT EXISTS "Attempt_official_guest_spot_version_unique"
ON "Attempt" ("guestSessionId", "spotVersionId")
WHERE "official" = true;

CREATE TABLE IF NOT EXISTS "Account" (
  "id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT,
  "roles" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Account_subject_key" ON "Account"("subject");
ALTER TABLE "Attempt" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "Attempt" ALTER COLUMN "guestSessionId" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "Attempt_accountId_createdAt_idx" ON "Attempt"("accountId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Attempt_official_account_spot_version_unique"
ON "Attempt" ("accountId", "spotVersionId")
WHERE "official" = true AND "accountId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Attempt_accountId_spotVersionId_idempotencyKey_key"
ON "Attempt" ("accountId", "spotVersionId", "idempotencyKey");
DO $$ BEGIN
  ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
