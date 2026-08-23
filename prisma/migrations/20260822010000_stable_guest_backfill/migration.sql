-- Repair pre-v3 rotation chains so every historical session in a chain points
-- to the same earliest guest identity. New rotations already preserve this ID.
DROP INDEX IF EXISTS "Attempt_guest_official_once_idx";
DROP INDEX IF EXISTS "Attempt_guestIdentityId_spotVersionId_idempotencyKey_key";

WITH RECURSIVE session_roots AS (
  SELECT id, "rotationOfId", "identityId" AS root_id
  FROM "GuestSession"
  WHERE "rotationOfId" IS NULL
  UNION ALL
  SELECT child.id, child."rotationOfId", parent.root_id
  FROM "GuestSession" child
  JOIN session_roots parent ON child."rotationOfId" = parent.id
)
UPDATE "GuestSession" session
SET "identityId" = roots.root_id
FROM session_roots roots
WHERE session.id = roots.id AND session."identityId" <> roots.root_id;

UPDATE "Attempt" attempt
SET "guestIdentityId" = session."identityId"
FROM "GuestSession" session
WHERE attempt."guestSessionId" = session.id
  AND attempt."guestIdentityId" IS DISTINCT FROM session."identityId";

-- Older schemas scoped these rules to a rotating session. Preserve every
-- attempt while deterministically translating collisions to identity scope.
WITH ranked_keys AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY "guestIdentityId", "spotVersionId", "idempotencyKey"
      ORDER BY "createdAt", id
    ) AS duplicate_number
  FROM "Attempt"
  WHERE "guestIdentityId" IS NOT NULL
)
UPDATE "Attempt" attempt
SET "idempotencyKey" = attempt."idempotencyKey" || ':migrated:' || attempt.id
FROM ranked_keys ranked
WHERE attempt.id = ranked.id AND ranked.duplicate_number > 1;

WITH ranked_official AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY "guestIdentityId", "spotVersionId"
      ORDER BY "createdAt", id
    ) AS attempt_number
  FROM "Attempt"
  WHERE "guestIdentityId" IS NOT NULL
)
UPDATE "Attempt" attempt
SET official = ranked.attempt_number = 1,
    "practiceOrdinal" = ranked.attempt_number - 1
FROM ranked_official ranked
WHERE attempt.id = ranked.id;

CREATE UNIQUE INDEX "Attempt_guestIdentityId_spotVersionId_idempotencyKey_key"
  ON "Attempt"("guestIdentityId", "spotVersionId", "idempotencyKey");
CREATE UNIQUE INDEX "Attempt_guest_official_once_idx"
  ON "Attempt"("guestIdentityId", "spotVersionId")
  WHERE official = TRUE AND "guestIdentityId" IS NOT NULL;

DELETE FROM "GuestIdentity" identity
WHERE NOT EXISTS (SELECT 1 FROM "GuestSession" session WHERE session."identityId" = identity.id)
  AND NOT EXISTS (SELECT 1 FROM "Attempt" attempt WHERE attempt."guestIdentityId" = identity.id);
