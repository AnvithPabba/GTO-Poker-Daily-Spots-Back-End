import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Prisma client generation is guarded wherever TypeScript consumes schema types", async () => {
  // Arrange
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const scripts = packageJson.scripts ?? {};

  // Act
  const guardedScripts = [scripts.prebuild, scripts.pretypecheck, scripts.pretest];

  // Assert
  assert.deepEqual(
    guardedScripts.map((script) => typeof script === "string" && script.includes("prisma generate")),
    [true, true, true],
  );
});

test("Attempt validity fields exist in both the Prisma model and its committed migration", async () => {
  // Arrange
  const schema = await readFile(resolve(root, "prisma/schema.prisma"), "utf8");
  const migration = await readFile(
    resolve(root, "prisma/migrations/20260823000100_attempt_quality_invalidation/migration.sql"),
    "utf8",
  );

  // Act
  const hasSchemaFields = [
    /enum\s+AttemptValidity/,
    /validity\s+AttemptValidity/,
    /invalidatedAt\s+DateTime\?/,
    /invalidationReason\s+String\?/,
    /replacementSpotVersionId\s+String\?/,
  ].every((field) => field.test(schema));
  const hasMigrationFields = ["CREATE TYPE \"AttemptValidity\"", "\"validity\"", "\"invalidatedAt\"", "\"invalidationReason\"", "\"replacementSpotVersionId\""]
    .every((field) => migration.includes(field));

  // Assert
  assert.equal(hasSchemaFields, true);
  assert.equal(hasMigrationFields, true);
  await access(resolve(root, "prisma/migrations/20260823000100_attempt_quality_invalidation/migration.sql"));
});
