import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

test("database schema, roles, immutability, and singleton constraints", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const suffix = `test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = {
    template: `${suffix}_template`, job: `${suffix}_job`, run: `${suffix}_run`, spot: `${suffix}_spot`, version: `${suffix}_version`, guest: `${suffix}_guest`, attempt: `${suffix}_attempt`,
  };
  const publicPayload = JSON.stringify({ schemaVersion: 2, spotId: ids.spot, spotVersionId: ids.version });
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO "SolverTemplate" (id, "familyId", version, name, config, "updatedAt") VALUES ($1, $2, 1, 'database test', $3::jsonb, now())`, [ids.template, suffix, '{"pot":50,"effective_stack":100,"board":["Qs","Jh","2h"],"ranges":{"ip":"AA","oop":"KK"}}']);
    await client.query(`INSERT INTO "SolverJob" (id, "templateId", "effectiveSeed", "updatedAt") VALUES ($1, $2, 'seed', now())`, [ids.job, ids.template]);
    await client.query(`INSERT INTO "SolverRun" (id, "jobId", "attemptNumber", status, "resolvedInput") VALUES ($1, $2, 1, 'SUCCEEDED', '{}'::jsonb)`, [ids.run, ids.job]);
    await client.query(`INSERT INTO "Spot" (id, title, "updatedAt") VALUES ($1, 'database test', now())`, [ids.spot]);
    await client.query(`INSERT INTO "SpotVersion" (id, "spotId", version, "solverRunId", "candidateManifest", "publicPayload", "privateSolutionPayload", "normalizerVersion", "selectionRankingVersion", "publicPayloadSha256", "privatePayloadSha256", status) VALUES ($1, $2, 1, $3, '{}'::jsonb, $4::jsonb, '{}'::jsonb, '1', '1', 'public-hash', 'private-hash', 'VALIDATED')`, [ids.version, ids.spot, ids.run, publicPayload]);
    await client.query(`INSERT INTO "GuestSession" (id, "tokenHash", "expiresAt") VALUES ($1, $2, now() + interval '1 day')`, [ids.guest, `${suffix}_token`]);
    await client.query(`INSERT INTO "Attempt" (id, "guestSessionId", "spotId", "spotVersionId", official, "idempotencyKey", "submittedPayload", "resultPayload", "overallSimilarity", "metricKey", "metricVersion", "aggregatorKey", "aggregatorVersion") VALUES ($1, $2, $3, $4, true, 'first-idempotency-key', '{}'::jsonb, '{}'::jsonb, 100, 'l1', 1, 'equal_average', 1)`, [ids.attempt, ids.guest, ids.spot, ids.version]);
    await client.query("SAVEPOINT before_constraints");
    await assert.rejects(() => client.query(`INSERT INTO "Attempt" (id, "guestSessionId", "spotId", "spotVersionId", official, "idempotencyKey", "submittedPayload", "resultPayload", "overallSimilarity", "metricKey", "metricVersion", "aggregatorKey", "aggregatorVersion") VALUES ($1, $2, $3, $4, true, 'second-idempotency-key', '{}'::jsonb, '{}'::jsonb, 100, 'l1', 1, 'equal_average', 1)`, [`${ids.attempt}_duplicate`, ids.guest, ids.spot, ids.version]), (error) => error?.code === "23505");
    await client.query("ROLLBACK TO SAVEPOINT before_constraints");
    await assert.rejects(() => client.query(`UPDATE "SpotVersion" SET "publicPayload" = '{"tampered":true}'::jsonb WHERE id = $1`, [ids.version]), /immutable/);
    await client.query("ROLLBACK TO SAVEPOINT before_constraints");
    await client.query(`INSERT INTO "PublicationSlot" (id, "publicationDate", "slotOrder", "spotVersionId", status, "updatedAt") VALUES ($1, DATE '2026-08-20', 1, $2, 'SCHEDULED', now())`, [`${suffix}_slot`, ids.version]);
    await client.query("SAVEPOINT before_slot_constraint");
    await assert.rejects(() => client.query(`INSERT INTO "PublicationSlot" (id, "publicationDate", "slotOrder", "spotVersionId", status, "updatedAt") VALUES ($1, DATE '2026-08-20', 1, $2, 'HELD', now())`, [`${suffix}_slot_duplicate`, ids.version]), (error) => error?.code === "23505");
    await client.query("ROLLBACK TO SAVEPOINT before_slot_constraint");
    const roleRows = await client.query("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ANY($1)", [[process.env.POSTGRES_APP_USER ?? "trainer_api", process.env.POSTGRES_WORKER_USER ?? "solver_worker"]]);
    assert.ok(roleRows.rows.every((row) => row.rolsuper === false && row.rolcreatedb === false && row.rolcreaterole === false));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
