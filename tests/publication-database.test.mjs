import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { addPacificDays, countFutureCoverage, publishPacificDate, approveSpotVersion, scheduleSpotVersion, pacificDate } from "../dist/publication.js";

const databaseUrl = process.env.DATABASE_URL;

test("database publication lifecycle is guarded and Pacific-date coverage counts approved/scheduled spots", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `publication_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = { template: `${suffix}_template`, job: `${suffix}_job`, run: `${suffix}_run`, spot: `${suffix}_spot`, version: `${suffix}_version` };
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
    const published = await publishPacificDate(prisma, date, new Date("2026-08-20T12:00:00.000Z"));
    assert.equal(published.length, 1);
    assert.equal((await prisma.spotVersion.findUniqueOrThrow({ where: { id: ids.version } })).status, "PUBLISHED");
    assert.equal((await prisma.publicationSlot.findUniqueOrThrow({ where: { id: slot.id } })).status, "PUBLISHED");
  } finally {
    await prisma.publicationSlot.deleteMany({ where: { spotVersionId: ids.version } });
    await prisma.spotVersion.deleteMany({ where: { id: ids.version } });
    await prisma.spot.deleteMany({ where: { id: ids.spot } });
    await prisma.solverRun.deleteMany({ where: { id: ids.run } });
    await prisma.solverJob.deleteMany({ where: { id: ids.job } });
    await prisma.solverTemplate.deleteMany({ where: { id: ids.template } });
    await prisma.$disconnect();
  }
});
