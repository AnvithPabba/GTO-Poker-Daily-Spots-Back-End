CREATE UNIQUE INDEX IF NOT EXISTS "Attempt_accountId_spotVersionId_idempotencyKey_key"
ON "Attempt" ("accountId", "spotVersionId", "idempotencyKey");
