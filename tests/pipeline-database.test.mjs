import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { persistValidatedDraft } from "../dist/solver/pipeline.js";
import { payloadSha256 } from "../dist/solver/normalized.js";

const databaseUrl = process.env.DATABASE_URL;

test("validated pipeline persists split payloads idempotently and rejects conflicting versions", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `pipeline_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = { template: `${suffix}_template`, job: `${suffix}_job`, retryJob: `${suffix}_retry`, siblingJob: `${suffix}_sibling_job`, collisionJob: `${suffix}_collision_job`, spot: `${suffix}_spot`, siblingSpot: `${suffix}_sibling_spot`, collisionSpot: `${suffix}_collision_spot`, version: `${suffix}_version`, siblingVersion: `${suffix}_sibling_version`, collisionVersion: `${suffix}_collision_version` };
  const sourceHash = createHash("sha256").update(`${suffix}:source`).digest("hex");
  const publicPayload = {
    schemaVersion: 3, spotId: ids.spot, spotVersionId: ids.version, publicationDate: "2026-08-21", slotOrder: 1,
    preflop: { status: "unknown", label: "Preflop start unavailable", summary: "Legacy fixture." },
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } }, history: [],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    legalActions: [{ id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false }, { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", solverLabel: "BET 25.000000", isAllIn: false }], featuredCombo: "AhAs", selectableCombos: [{ combo: "AhAs", category: "pair" }], presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
  const privatePayload = { schemaVersion: 1, actionOrder: ["a0", "a1"], byCombo: { AhAs: { reachWeight: 0.75, frequencies: { a0: 2_500, a1: 7_500 } } }, reachedRanges: { hero: { AhAs: 0.75 }, opponent: { KcKd: 1 } } };
  const envelope = { schemaVersion: 3, sourceHash, publicPayload, privateSolutionPayload: privatePayload, candidateManifest: { sourceHash, path: ["root", "decision"], selectedCombo: "AhAs", fallbackUsed: false, rankingVersion: "1" }, provenance: { normalizerVersion: "3", selectionRankingVersion: "1" } };
  const baseInput = { jobId: ids.job, attemptNumber: 1, resolvedInput: { pot: 50, effective_stack: 100, board: ["Qs", "Jh", "2h"], ranges: { ip: "AA", oop: "KK" } }, inputSha256: "1".repeat(64), outputSha256: "2".repeat(64), logSha256: "3".repeat(64), archiveInputKey: `solver-runs/sha256/${sourceHash}/input.txt`, archiveOutputKey: `solver-runs/sha256/${sourceHash}/output_result.json`, archiveLogKey: `solver-runs/sha256/${sourceHash}/solver.log` };
  try {
    await prisma.solverTemplate.create({ data: { id: ids.template, familyId: suffix, version: 1, name: "pipeline test", config: baseInput.resolvedInput, updatedAt: new Date() } });
    await prisma.solverJob.create({ data: { id: ids.job, templateId: ids.template, effectiveSeed: `${suffix}:seed`, updatedAt: new Date() } });
    const first = await persistValidatedDraft(prisma, baseInput, envelope, { title: "Pipeline test spot" });
    assert.equal(first.version.status, "VALIDATED");
    assert.equal(first.version.version, 1);
    assert.equal(first.version.publicPayloadSha256, payloadSha256(publicPayload));
    assert.equal(first.version.privatePayloadSha256, payloadSha256(privatePayload));
    assert.equal(first.version.publicPayload.privateSolutionPayload, undefined);
    assert.ok(first.version.privateSolutionPayload.byCombo.AhAs.frequencies);

    await prisma.solverJob.create({ data: { id: ids.retryJob, templateId: ids.template, effectiveSeed: `${suffix}:retry`, updatedAt: new Date() } });
    const replay = await persistValidatedDraft(prisma, { ...baseInput, jobId: ids.retryJob }, envelope, { title: "Pipeline test spot" });
    assert.equal(replay.version.id, ids.version);
    assert.equal(replay.run.id, first.run.id);
    assert.equal((await prisma.solverRun.count({ where: { jobId: ids.job } })), 1);
    assert.equal((await prisma.solverJob.findUniqueOrThrow({ where: { id: ids.retryJob } })).status, "SUCCEEDED");

    // A single native solve can export several decision nodes. Its immutable
    // SolverRun must be reused instead of violating outputSha256 uniqueness.
    await prisma.solverJob.create({ data: { id: ids.siblingJob, templateId: ids.template, effectiveSeed: `${suffix}:sibling`, updatedAt: new Date() } });
    const siblingEnvelope = structuredClone(envelope);
    siblingEnvelope.publicPayload.spotId = ids.siblingSpot;
    siblingEnvelope.publicPayload.spotVersionId = ids.siblingVersion;
    const sibling = await persistValidatedDraft(prisma, { ...baseInput, jobId: ids.siblingJob }, siblingEnvelope, { title: "Sibling node from same solve" });
    assert.equal(sibling.run.id, first.run.id);
    assert.equal(sibling.version.solverRunId, first.run.id);
    assert.equal(await prisma.solverRun.count({ where: { outputSha256: baseInput.outputSha256 } }), 1);
    assert.equal((await prisma.solverJob.findUniqueOrThrow({ where: { id: ids.siblingJob } })).status, "SUCCEEDED");

    // Distinct input/output source identities must remain distinct even if
    // TexasSolver happens to emit byte-identical output JSON.
    await prisma.solverJob.create({ data: { id: ids.collisionJob, templateId: ids.template, effectiveSeed: `${suffix}:collision`, updatedAt: new Date() } });
    const collisionEnvelope = structuredClone(envelope);
    collisionEnvelope.sourceHash = createHash("sha256").update(`${suffix}:collision-source`).digest("hex");
    collisionEnvelope.candidateManifest.sourceHash = collisionEnvelope.sourceHash;
    collisionEnvelope.publicPayload.spotId = ids.collisionSpot;
    collisionEnvelope.publicPayload.spotVersionId = ids.collisionVersion;
    const collision = await persistValidatedDraft(
      prisma,
      { ...baseInput, jobId: ids.collisionJob, inputSha256: "4".repeat(64), logSha256: "5".repeat(64) },
      collisionEnvelope,
      { title: "Different solve with matching output bytes" },
    );
    assert.notEqual(collision.run.id, first.run.id);
    assert.equal(await prisma.solverRun.count({ where: { outputSha256: baseInput.outputSha256 } }), 2);

    const conflict = structuredClone(envelope);
    conflict.privateSolutionPayload.byCombo.AhAs.reachWeight = 0.5;
    await assert.rejects(() => persistValidatedDraft(prisma, { ...baseInput, jobId: ids.retryJob }, conflict, { title: "Pipeline test spot" }), /already exists with different content/);
  } finally {
    await prisma.solverJob.updateMany({ where: { id: { in: [ids.job, ids.retryJob, ids.siblingJob, ids.collisionJob] } }, data: { successfulRunId: null } });
    await prisma.spotVersion.deleteMany({ where: { id: { in: [ids.version, ids.siblingVersion, ids.collisionVersion] } } });
    await prisma.spot.deleteMany({ where: { id: { in: [ids.spot, ids.siblingSpot, ids.collisionSpot] } } });
    await prisma.solverRun.deleteMany({ where: { jobId: { in: [ids.job, ids.retryJob, ids.siblingJob, ids.collisionJob] } } });
    await prisma.solverJob.deleteMany({ where: { id: { in: [ids.job, ids.retryJob, ids.siblingJob, ids.collisionJob] } } });
    await prisma.solverTemplate.deleteMany({ where: { id: ids.template } });
    await prisma.$disconnect();
  }
});
