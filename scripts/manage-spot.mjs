#!/usr/bin/env node
import { createPrismaClient } from "../dist/db.js";
import { approveSpotVersion, publishPacificDate, quarantinePublishedVersion, replacePublishedSlot, scheduleSpotVersion } from "../dist/publication.js";

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token?.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    result[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

const commandArgs = process.argv.slice(2);
if (commandArgs[0] === "--") commandArgs.shift();
const [command, ...rest] = commandArgs;
const options = args(rest);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const prisma = createPrismaClient(process.env.DATABASE_URL);

try {
  if (command === "approve") {
    if (!options["spot-version-id"]) throw new Error("approve requires --spot-version-id");
    const version = await approveSpotVersion(prisma, options["spot-version-id"]);
    console.log(JSON.stringify({ action: "approved", spotVersionId: version.id, status: version.status }, null, 2));
  } else if (command === "schedule") {
    if (!options["spot-version-id"] || !options.date || !options.order) throw new Error("schedule requires --spot-version-id, --date YYYY-MM-DD, and --order N");
    const slot = await scheduleSpotVersion(prisma, options["spot-version-id"], options.date, Number(options.order));
    console.log(JSON.stringify({ action: "scheduled", slotId: slot.id, spotVersionId: slot.spotVersionId, date: options.date, slotOrder: slot.slotOrder, status: slot.status }, null, 2));
  } else if (command === "publish") {
    if (!options.date) throw new Error("publish requires --date YYYY-MM-DD");
    const published = await publishPacificDate(prisma, options.date, new Date());
    console.log(JSON.stringify({ action: "published", date: options.date, count: published.length, slots: published.map((slot) => slot.id) }, null, 2));
  } else if (command === "replace") {
    if (!options["old-version-id"] || !options["new-version-id"]) throw new Error("replace requires --old-version-id and --new-version-id");
    const result = await replacePublishedSlot(prisma, options["old-version-id"], options["new-version-id"], options.invalidate ? {
      reason: options.reason ?? "published solver version failed quality validation",
      actor: options.actor ?? "local-repair",
    } : undefined);
    console.log(JSON.stringify({ action: "replaced", oldVersionId: result.oldVersionId, newVersionId: result.newVersionId, slotId: result.slot.id, date: result.slot.publicationDate, slotOrder: result.slot.slotOrder, invalidatedAttempts: result.invalidatedAttempts, status: result.slot.status }, null, 2));
  } else if (command === "quarantine") {
    if (!options["spot-version-id"] || !options.reason) throw new Error("quarantine requires --spot-version-id and --reason");
    const result = await quarantinePublishedVersion(prisma, options["spot-version-id"], options.reason, options.actor ?? "local-quality-gate");
    console.log(JSON.stringify({ action: "quarantined", ...result }, null, 2));
  } else {
    throw new Error("usage: manage-spot.mjs approve|schedule|publish|replace|quarantine [options]");
  }
} finally {
  await prisma.$disconnect();
}
