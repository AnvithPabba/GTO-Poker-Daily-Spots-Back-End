import type { PgBoss } from "pg-boss";
import type { PrismaClient } from "@prisma/client";

export const QUEUES = {
  solverTemplate: "solver-template",
  publication: "publication",
  replenishment: "replenishment",
} as const;

export async function ensureQueueFoundation(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.solverTemplate, { policy: "standard", retentionSeconds: 1_209_600 });
  await boss.createQueue(QUEUES.publication, { policy: "singleton", retentionSeconds: 1_209_600 });
  await boss.createQueue(QUEUES.replenishment, { policy: "singleton", retentionSeconds: 1_209_600 });
}

/** Install the two independent Pacific schedules exactly once per queue key. */
export async function ensureQueueSchedules(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUES.replenishment, "0 0 18 * * *", {}, { tz: "America/Los_Angeles", key: "pacific-replenishment" });
  await boss.schedule(QUEUES.publication, "0 0 0 * * *", {}, { tz: "America/Los_Angeles", key: "pacific-publication" });
}

export function replenishmentPlan(coverage: number, target = 7, alertThreshold = 3): { coverage: number; deficit: number; alert: boolean } {
  if (!Number.isInteger(coverage) || coverage < 0 || !Number.isInteger(target) || target < 1 || !Number.isInteger(alertThreshold) || alertThreshold < 0) throw new Error("coverage and thresholds must be non-negative integers");
  return { coverage, deficit: Math.max(0, target - coverage), alert: coverage < alertThreshold };
}

export async function queueFoundationStatus(boss: PgBoss, prisma: PrismaClient) {
  const queues = await boss.getQueues();
  await prisma.$queryRaw`SELECT 1`;
  return { installed: await boss.isInstalled(), queues: queues.map((queue) => queue.name).sort() };
}
