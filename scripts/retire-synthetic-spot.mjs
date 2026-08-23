#!/usr/bin/env node
/**
 * One-time local-data cleanup for the pre-import development fixture.
 *
 * It deliberately keeps attempts and immutable JSON for audit/history, but
 * cancels its publication slots and removes the version from public serving.
 * Fresh databases never contain this row; use this only for volumes created
 * before the content-free seed was installed.
 */
import { createPrismaClient } from "../dist/db.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const spotId = process.env.SYNTHETIC_SPOT_ID ?? "development-default-spot";
const prisma = createPrismaClient(process.env.DATABASE_URL);

try {
  const result = await prisma.$transaction(async (tx) => {
    const spot = await tx.spot.findUnique({ where: { id: spotId }, include: { versions: { select: { id: true, status: true } } } });
    if (!spot) return { spotId, retired: false, reason: "not found" };
    const versionIds = spot.versions.map((version) => version.id);
    const slots = await tx.publicationSlot.updateMany({
      where: { spotVersionId: { in: versionIds }, status: { in: ["SCHEDULED", "HELD", "PUBLISHED"] } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    const versions = await tx.spotVersion.updateMany({
      where: { id: { in: versionIds }, status: { in: ["DRAFT", "VALIDATED", "APPROVED", "SCHEDULED", "PUBLISHED"] } },
      data: { status: "SUPERSEDED", supersededAt: new Date() },
    });
    await tx.spot.update({ where: { id: spotId }, data: { status: "ARCHIVED", currentVersionId: null } });
    return { spotId, retired: true, versions: versions.count, slots: slots.count };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
