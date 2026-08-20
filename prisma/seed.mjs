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
  const seededTemplate = await prisma.solverTemplate.upsert({
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

  // This deliberately synthetic, local-only fixture makes a clean checkout
  // usable in the browser without pretending that a real solver answer is
  // part of the repository.  Native Solver ingestion replaces these rows in
  // a real environment.
  const publicationDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [year, month, day] = publicationDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day - 1));
  const dateString = date.toISOString().slice(0, 10);
  const ids = { template: seededTemplate.id, job: "development-default-job", run: "development-default-run", spot: "development-default-spot", version: "development-default-spot-v1", slot: "development-default-slot" };
  const sourceHash = "f".repeat(64);
  const publicPayload = {
    schemaVersion: 2,
    spotId: ids.spot,
    spotVersionId: ids.version,
    publicationDate: dateString,
    slotOrder: 1,
    initialState: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "oop", allIn: { ip: false, oop: false } },
    history: [{ kind: "action", actor: "oop", actionType: "check", solverLabel: "CHECK" }],
    decision: { board: ["Qs", "Jh", "2h"], pot: 50, stacks: { ip: 100, oop: 100 }, street: "flop", actor: "ip", allIn: { ip: false, oop: false } },
    legalActions: [
      { id: "a0", type: "check", displayLabel: "Check", solverLabel: "CHECK", isAllIn: false },
      { id: "a1", type: "bet", amount: 25, displayLabel: "Bet 25", solverLabel: "BET 25.000000", isAllIn: false },
      { id: "a2", type: "bet", amount: 75, displayLabel: "Bet 75", solverLabel: "BET 75.000000", isAllIn: false },
    ],
    featuredCombo: "AhAs",
    selectableCombos: [{ combo: "AhAs", category: "pair" }, { combo: "AcAd", category: "pair" }, { combo: "KhQh", category: "suited" }],
    presentation: { heroActor: "ip", dealerActor: "ip", positions: { ip: "BTN", oop: "BB" }, holdingVisibility: "featured_hero", chipUnit: "bb" },
  };
  const privateSolutionPayload = {
    schemaVersion: 1,
    actionOrder: ["a0", "a1", "a2"],
    byCombo: {
      AhAs: { reachWeight: 1, frequencies: { a0: 1_500, a1: 7_000, a2: 1_500 } },
      AcAd: { reachWeight: 0.8, frequencies: { a0: 5_000, a1: 4_000, a2: 1_000 } },
      KhQh: { reachWeight: 0.5, frequencies: { a0: 7_000, a1: 2_500, a2: 500 } },
    },
    reachedRanges: { hero: { AhAs: 1, AcAd: 0.8, KhQh: 0.5 }, opponent: { QcQd: 1 } },
  };
  await prisma.solverJob.upsert({ where: { id: ids.job }, update: { templateId: ids.template, effectiveSeed: "development-seed-1", status: "SUCCEEDED", attemptCount: 1 }, create: { id: ids.job, templateId: ids.template, effectiveSeed: "development-seed-1", status: "SUCCEEDED", attemptCount: 1 } });
  await prisma.solverRun.upsert({ where: { id: ids.run }, update: { jobId: ids.job, attemptNumber: 1, status: "SUCCEEDED", resolvedInput: config, sourceHash, outputSha256: `${sourceHash}_output` }, create: { id: ids.run, jobId: ids.job, attemptNumber: 1, status: "SUCCEEDED", resolvedInput: config, sourceHash, outputSha256: `${sourceHash}_output` } });
  await prisma.solverJob.update({ where: { id: ids.job }, data: { successfulRunId: ids.run } });
  await prisma.spot.upsert({ where: { id: ids.spot }, update: { title: "Development flop: BTN versus BB", status: "PUBLISHED", currentVersionId: ids.version }, create: { id: ids.spot, title: "Development flop: BTN versus BB", status: "PUBLISHED" } });
  await prisma.spotVersion.upsert({ where: { id: ids.version }, update: { spotId: ids.spot, version: 1, solverRunId: ids.run, candidateManifest: { sourceHash, path: ["root", "CHECK"] }, publicPayload, privateSolutionPayload, publicPayloadSha256: sourceHash, privatePayloadSha256: sourceHash, schemaVersion: 2, normalizerVersion: "seed", selectionRankingVersion: "1", status: "PUBLISHED", publishedAt: new Date() }, create: { id: ids.version, spotId: ids.spot, version: 1, solverRunId: ids.run, candidateManifest: { sourceHash, path: ["root", "CHECK"] }, publicPayload, privateSolutionPayload, publicPayloadSha256: sourceHash, privatePayloadSha256: sourceHash, schemaVersion: 2, normalizerVersion: "seed", selectionRankingVersion: "1", status: "PUBLISHED", publishedAt: new Date() } });
  await prisma.spot.update({ where: { id: ids.spot }, data: { currentVersionId: ids.version, status: "PUBLISHED" } });
  await prisma.publicationSlot.upsert({ where: { id: ids.slot }, update: { publicationDate: date, slotOrder: 1, spotVersionId: ids.version, status: "PUBLISHED", publishedAt: new Date() }, create: { id: ids.slot, publicationDate: date, slotOrder: 1, spotVersionId: ids.version, status: "PUBLISHED", publishedAt: new Date() } });
  console.log(`seeded local development spot ${ids.spot} for ${dateString}`);
} finally {
  await prisma.$disconnect();
}
