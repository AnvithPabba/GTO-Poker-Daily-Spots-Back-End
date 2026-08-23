import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { addPacificDays, countFutureCoverage, publishPacificDate, approveSpotVersion, quarantinePublishedVersion, replacePublishedSlot, scheduleSpotVersion, pacificDate } from "../dist/publication.js";

const databaseUrl = process.env.DATABASE_URL;

test("database publication lifecycle is guarded and Pacific-date coverage counts approved/scheduled spots", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `publication_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = { template: `${suffix}_template`, job: `${suffix}_job`, run: `${suffix}_run`, spot: `${suffix}_spot`, version: `${suffix}_version`, replacementSpot: `${suffix}_replacement_spot`, replacement: `${suffix}_replacement` };
  const date = addPacificDays(pacificDate(), 1);
  try {
    await prisma.solverTemplate.create({ data: { id: ids.template, familyId: suffix, version: 1, name: "publication test", config: { pot: 50, effective_stack: 100, board: ["Qs", "Jh", "2h"], ranges: { ip: "AA", oop: "KK" } }, updatedAt: new Date() } });
    await prisma.solverJob.create({ data: { id: ids.job, templateId: ids.template, effectiveSeed: suffix, updatedAt: new Date() } });
    await prisma.solverRun.create({ data: { id: ids.run, jobId: ids.job, attemptNumber: 1, status: "SUCCEEDED", resolvedInput: {}, sourceHash: "e".repeat(64), outputSha256: `${suffix}_output` } });
    await prisma.spot.create({ data: { id: ids.spot, title: "publication test", updatedAt: new Date() } });
    await prisma.spotVersion.create({ data: { id: ids.version, spotId: ids.spot, version: 1, solverRunId: ids.run, candidateManifest: {}, publicPayload: {}, privateSolutionPayload: {}, normalizerVersion: "1", selectionRankingVersion: "1", publicPayloadSha256: `${suffix}_public`, privatePayloadSha256: `${suffix}_private`, status: "VALIDATED", validatedAt: new Date() } });
    await approveSpotVersion(prisma, ids.version);
    assert.equal(await countFutureCoverage(prisma, pacificDate()), 1);
    const slot = await scheduleSpotVersion(prisma, ids.version, date, 1);
    assert.equal(slot.status, "SCHEDULED");
    assert.equal(await countFutureCoverage(prisma, pacificDate()), 1);
    await prisma.spot.create({ data: { id: ids.replacementSpot, title: "replacement publication test", updatedAt: new Date() } });
    await prisma.spotVersion.create({ data: { id: ids.replacement, spotId: ids.replacementSpot, version: 1, solverRunId: ids.run, candidateManifest: {}, publicPayload: {}, privateSolutionPayload: {}, normalizerVersion: "1", selectionRankingVersion: "1", publicPayloadSha256: `${suffix}_replacement_public`, privatePayloadSha256: `${suffix}_replacement_private`, status: "VALIDATED", validatedAt: new Date() } });
    await approveSpotVersion(prisma, ids.replacement);
    const replacement = await replacePublishedSlot(prisma, ids.version, ids.replacement, { reason: "operator replaced a future date", actor: "test-operator" });
    assert.equal(replacement.previousSlotStatus, "SCHEDULED");
    assert.equal(replacement.slot.status, "SCHEDULED");
    assert.equal((await prisma.spotVersion.findUniqueOrThrow({ where: { id: ids.version } })).status, "SUPERSEDED");
    assert.equal((await prisma.publicationSlot.findUniqueOrThrow({ where: { id: slot.id } })).status, "CANCELLED");
    assert.equal((await prisma.spot.findUniqueOrThrow({ where: { id: ids.spot } })).status, "ARCHIVED");
    const published = await publishPacificDate(prisma, date, new Date("2026-08-20T12:00:00.000Z"));
    assert.equal(published.length, 1);
    assert.equal((await prisma.spotVersion.findUniqueOrThrow({ where: { id: ids.replacement } })).status, "PUBLISHED");
    assert.equal((await prisma.publicationSlot.findUniqueOrThrow({ where: { id: replacement.slot.id } })).status, "PUBLISHED");
    const quarantined = await quarantinePublishedVersion(prisma, ids.replacement, "native solver emitted one uniform all-in vector", "test-operator");
    assert.equal(quarantined.cancelledSlots, 1);
    assert.equal((await prisma.spotVersion.findUniqueOrThrow({ where: { id: ids.replacement } })).status, "SUPERSEDED");
    assert.equal((await prisma.publicationSlot.findUniqueOrThrow({ where: { id: replacement.slot.id } })).status, "CANCELLED");
    const retiredSpot = await prisma.spot.findUniqueOrThrow({ where: { id: ids.replacementSpot } });
    assert.equal(retiredSpot.status, "ARCHIVED");
    assert.equal(retiredSpot.currentVersionId, null);
    const audit = await prisma.adminAudit.findFirstOrThrow({ where: { operation: "quarantine_invalid_solver_version", targetId: ids.replacement } });
    assert.equal(audit.actor, "test-operator");
  } finally {
    await prisma.adminAudit.deleteMany({ where: { targetId: { in: [ids.version, ids.replacement] } } });
    await prisma.publicationSlot.deleteMany({ where: { spotVersionId: { in: [ids.version, ids.replacement] } } });
    await prisma.spotVersion.deleteMany({ where: { id: { in: [ids.version, ids.replacement] } } });
    await prisma.spot.deleteMany({ where: { id: { in: [ids.spot, ids.replacementSpot] } } });
    await prisma.solverRun.deleteMany({ where: { id: ids.run } });
    await prisma.solverJob.deleteMany({ where: { id: ids.job } });
    await prisma.solverTemplate.deleteMany({ where: { id: ids.template } });
    await prisma.$disconnect();
  }
});
