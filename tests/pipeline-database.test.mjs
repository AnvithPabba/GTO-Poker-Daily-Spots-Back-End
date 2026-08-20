import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { persistValidatedDraft } from "../dist/solver/pipeline.js";
import { payloadSha256 } from "../dist/solver/normalized.js";

const databaseUrl = process.env.DATABASE_URL;

test("validated pipeline persists split payloads idempotently and rejects conflicting versions", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `pipeline_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = { template: `${suffix}_template`, job: `${suffix}_job`, retryJob: `${suffix}_retry`, spot: `${suffix}_spot`, version: `${suffix}_version` };
  const sourceHash = "e".repeat(64);
  const publicPayload = {
    schemaVersion: 2, spotId: ids.spot, spotVersionId: ids.version, publicationDate: "2026-08-21", slotOrder: 1,
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } }, history: [],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    legalActions: [{ id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false }, { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", solverLabel: "BET 25.000000", isAllIn: false }], featuredCombo: "AhAs", selectableCombos: [{ combo: "AhAs", category: "pair" }], presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
  const privatePayload = { schemaVersion: 1, actionOrder: ["a0", "a1"], byCombo: { AhAs: { reachWeight: 0.75, frequencies: { a0: 2_500, a1: 7_500 } } }, reachedRanges: { hero: { AhAs: 0.75 }, opponent: { KcKd: 1 } } };
  const envelope = { schemaVersion: 2, sourceHash, publicPayload, privateSolutionPayload: privatePayload, candidateManifest: { sourceHash, path: ["root", "decision"], selectedCombo: "AhAs", fallbackUsed: false, rankingVersion: "1" }, provenance: { normalizerVersion: "2", selectionRankingVersion: "1" } };
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

    const conflict = structuredClone(envelope);
    conflict.privateSolutionPayload.byCombo.AhAs.reachWeight = 0.5;
    await assert.rejects(() => persistValidatedDraft(prisma, { ...baseInput, jobId: ids.retryJob }, conflict, { title: "Pipeline test spot" }), /already exists with different content/);
  } finally {
    await prisma.solverJob.updateMany({ where: { id: { in: [ids.job, ids.retryJob] } }, data: { successfulRunId: null } });
    await prisma.spotVersion.deleteMany({ where: { id: ids.version } });
    await prisma.spot.deleteMany({ where: { id: ids.spot } });
    await prisma.solverRun.deleteMany({ where: { jobId: { in: [ids.job, ids.retryJob] } } });
    await prisma.solverJob.deleteMany({ where: { id: { in: [ids.job, ids.retryJob] } } });
    await prisma.solverTemplate.deleteMany({ where: { id: ids.template } });
    await prisma.$disconnect();
  }
});
