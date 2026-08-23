import { PrismaClient } from "@prisma/client";

/**
 * Production-safe development seed.
 *
 * Solver content is intentionally not seeded here. A published spot must come
 * from a real, validated provider envelope imported by scripts/ingest-spot.mjs.
 * Keeping this seed content-free prevents a fabricated story/range from being
 * mistaken for a solver result and makes a fresh database accurately represent
 * an empty publication calendar.
 */
const prisma = new PrismaClient();

try {
  const publishedSpots = await prisma.publicationSlot.count({ where: { status: "PUBLISHED" } });
  console.log(`database seed complete; preserved ${publishedSpots} published slot(s), added no solver content`);
} finally {
  await prisma.$disconnect();
}
