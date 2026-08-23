import { PrismaClient } from "@prisma/client";
import { migrateLegacySpotVersions } from "../dist/solver/migrate-v3.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const prisma = new PrismaClient();
try {
  const result = await migrateLegacySpotVersions(prisma);
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
