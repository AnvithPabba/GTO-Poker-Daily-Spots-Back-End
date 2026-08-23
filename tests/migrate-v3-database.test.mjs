import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { migrateLegacySpotVersions } from "../dist/solver/migrate-v3.js";
import { payloadSha256 } from "../dist/solver/normalized.js";

const databaseUrl = process.env.DATABASE_URL;

test("v2 forward migration creates an immutable v3 copy and retargets mutable publication references", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  // Arrange
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `migrate_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const ids = { template: `${suffix}_template`, job: `${suffix}_job`, run: `${suffix}_run`, spot: `${suffix}_spot`, version: `${suffix}_v2`, slot: `${suffix}_slot` };
  const publicPayload = {
    schemaVersion: 2, spotId: ids.spot, spotVersionId: ids.version, publicationDate: "2026-07-14", slotOrder: 1,
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    history: [{ kind: "action", actor: "oop", actionType: "check", solverLabel: "CHECK" }],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "ip", allIn: { ip: false, oop: false } },
    legalActions: [{ id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false }],
    featuredCombo: "AhAs", selectableCombos: [{ combo: "AhAs", category: "pair" }],
    presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
  const privatePayload = { schemaVersion: 1, actionOrder: ["a0"], byCombo: { AhAs: { frequencies: { a0: 10000 } } } };
  try {
    await prisma.solverTemplate.create({ data: { id: ids.template, familyId: suffix, version: 1, name: "migration test", config: {}, updatedAt: new Date() } });
    await prisma.solverJob.create({ data: { id: ids.job, templateId: ids.template, effectiveSeed: suffix, updatedAt: new Date() } });
    await prisma.solverRun.create({ data: { id: ids.run, jobId: ids.job, attemptNumber: 1, status: "SUCCEEDED", resolvedInput: {}, outputSha256: `${suffix}_output` } });
    await prisma.spot.create({ data: { id: ids.spot, title: "Legacy spot", status: "PUBLISHED", updatedAt: new Date() } });
    await prisma.spotVersion.create({ data: { id: ids.version, spotId: ids.spot, version: 1, solverRunId: ids.run, schemaVersion: 2, candidateManifest: {}, publicPayload, privateSolutionPayload: privatePayload, normalizerVersion: "2", selectionRankingVersion: "1", publicPayloadSha256: payloadSha256(publicPayload), privatePayloadSha256: payloadSha256(privatePayload), status: "PUBLISHED", publishedAt: new Date() } });
    await prisma.spot.update({ where: { id: ids.spot }, data: { currentVersionId: ids.version } });
    await prisma.publicationSlot.create({ data: { id: ids.slot, publicationDate: new Date("2026-07-14T00:00:00.000Z"), slotOrder: 1, spotVersionId: ids.version, status: "PUBLISHED", publishedAt: new Date(), updatedAt: new Date() } });

    // Act
    const first = await migrateLegacySpotVersions(prisma, { versionIds: [ids.version] });
    const second = await migrateLegacySpotVersions(prisma, { versionIds: [ids.version] });
    const versions = await prisma.spotVersion.findMany({ where: { spotId: ids.spot }, orderBy: { version: "asc" } });
    const spot = await prisma.spot.findUniqueOrThrow({ where: { id: ids.spot } });
    const slot = await prisma.publicationSlot.findUniqueOrThrow({ where: { id: ids.slot } });

    // Assert
    assert.deepEqual(first, { migrated: 1, alreadyMigrated: 0 });
    assert.deepEqual(second, { migrated: 0, alreadyMigrated: 1 });
    assert.equal(versions.length, 2);
    assert.equal(versions[0].schemaVersion, 2);
    assert.equal(versions[1].schemaVersion, 3);
    assert.equal(versions[1].publicPayload.preflop.status, "unknown");
    assert.equal(versions[0].publicPayload.preflop, undefined);
    assert.equal(spot.currentVersionId, versions[1].id);
    assert.equal(slot.spotVersionId, versions[1].id);
  } finally {
    await prisma.publicationSlot.deleteMany({ where: { id: ids.slot } });
    await prisma.spot.updateMany({ where: { id: ids.spot }, data: { currentVersionId: null } });
    await prisma.spotVersion.deleteMany({ where: { spotId: ids.spot } });
    await prisma.spot.deleteMany({ where: { id: ids.spot } });
    await prisma.solverRun.deleteMany({ where: { id: ids.run } });
    await prisma.solverJob.deleteMany({ where: { id: ids.job } });
    await prisma.solverTemplate.deleteMany({ where: { id: ids.template } });
    await prisma.$disconnect();
  }
});
