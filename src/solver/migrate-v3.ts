import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { readPublicSpot } from "../application/public-api.js";
import { payloadSha256 } from "./normalized.js";

function migratedId(oldId: string): string { return `v3_${createHash("sha256").update(oldId).digest("hex").slice(0, 28)}`; }

/**
 * Forward-copy immutable v2 versions into v3. The old rows and their hashes
 * remain untouched. Mutable publication/current-version references are moved
 * to the new copy in the same transaction.
 */
export async function migrateLegacySpotVersions(prisma: PrismaClient, options: { versionIds?: string[] } = {}): Promise<{ migrated: number; alreadyMigrated: number }> {
  const legacy = await prisma.spotVersion.findMany({
    where: { schemaVersion: 2, ...(options.versionIds ? { id: { in: options.versionIds } } : {}) },
    orderBy: [{ spotId: "asc" }, { version: "asc" }],
  });
  let migrated = 0; let alreadyMigrated = 0;
  for (const old of legacy) {
    const id = migratedId(old.id);
    const existing = await prisma.spotVersion.findUnique({ where: { id } });
    if (existing) { alreadyMigrated += 1; continue; }
    await prisma.$transaction(async (tx) => {
      const latest = await tx.spotVersion.aggregate({ where: { spotId: old.spotId }, _max: { version: true } });
      const publicPayload = { ...readPublicSpot(old.publicPayload), spotVersionId: id };
      await tx.spotVersion.create({ data: {
        id, spotId: old.spotId, version: (latest._max.version ?? 0) + 1, solverRunId: old.solverRunId,
        candidateManifest: old.candidateManifest as Prisma.InputJsonValue,
        publicPayload: publicPayload as Prisma.InputJsonValue,
        privateSolutionPayload: old.privateSolutionPayload as Prisma.InputJsonValue,
        schemaVersion: 3, normalizerVersion: `${old.normalizerVersion}+v3-forward`, selectionRankingVersion: old.selectionRankingVersion,
        publicPayloadSha256: payloadSha256(publicPayload), privatePayloadSha256: old.privatePayloadSha256,
        validationReport: { migratedFromVersionId: old.id, legacyPreflopContext: "unknown" },
        status: old.status, validatedAt: old.validatedAt, approvedAt: old.approvedAt, scheduledAt: old.scheduledAt,
        publishedAt: old.publishedAt, supersededAt: old.supersededAt,
      } });
      await tx.publicationSlot.updateMany({ where: { spotVersionId: old.id }, data: { spotVersionId: id } });
      await tx.spot.updateMany({ where: { id: old.spotId, currentVersionId: old.id }, data: { currentVersionId: id } });
    });
    migrated += 1;
  }
  return { migrated, alreadyMigrated };
}
