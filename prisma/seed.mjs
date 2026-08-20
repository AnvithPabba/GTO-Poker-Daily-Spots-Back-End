import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const config = {
    schemaVersion: 2,
    pot: 50,
    effective_stack: 100,
    board: ["Qs", "Jh", "2h"],
    ranges: { ip: "AA,KK,QQ,JJ", oop: "AA,KK,QQ,JJ" },
    solver: { threads: 1, iterations: 1000, dump_rounds: 3 },
    selection: { preferredStreet: "flop", preferredActor: "oop", minimumReach: 0.01 },
  };
  await prisma.solverTemplate.upsert({
    where: { familyId_version: { familyId: "development-default", version: 1 } },
    update: { config },
    create: {
      familyId: "development-default",
      version: 1,
      name: "Development default spot template",
      description: "Deterministic placeholder metadata for local infrastructure tests.",
      tags: ["development", "seed"],
      config,
      configSchemaVersion: 1,
      selectionRankingVersion: "1",
      defaultSeed: "development-seed-1",
    },
  });
} finally {
  await prisma.$disconnect();
}
