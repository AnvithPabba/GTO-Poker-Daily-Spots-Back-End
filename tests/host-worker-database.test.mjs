import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { claimSolverJob, completeSolverJob, failSolverJob, heartbeatSolverJob } from "../dist/solver/host-worker.js";

const databaseUrl = process.env.DATABASE_URL;

test("host-worker leases, heartbeats, retries, and terminal completion are ownership-checked", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = `lease_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const templateId = `${suffix}_template`;
  const retryJobId = `${suffix}_retry`;
  const completeJobId = `${suffix}_complete`;
  const runId = `${suffix}_run`;
  const start = new Date("2026-08-20T12:00:00.000Z");
  try {
    await prisma.solverTemplate.create({ data: { id: templateId, familyId: suffix, version: 1, name: "lease test", config: { pot: 50, effective_stack: 100, board: ["Qs", "Jh", "2h"], ranges: { ip: "AA", oop: "KK" } }, updatedAt: start } });
    await prisma.solverJob.createMany({ data: [
      { id: retryJobId, templateId, effectiveSeed: `${suffix}:retry`, priority: 10, maxAttempts: 3, updatedAt: start },
      { id: completeJobId, templateId, effectiveSeed: `${suffix}:complete`, maxAttempts: 3, updatedAt: start },
    ] });

    const first = await claimSolverJob(prisma, "worker-a", start, 60_000);
    assert.ok(first);
    assert.equal(first.leaseOwner, "worker-a");
    await heartbeatSolverJob(prisma, first.id, "worker-a", new Date(start.getTime() + 10_000), 60_000);
    await assert.rejects(() => heartbeatSolverJob(prisma, first.id, "worker-b", new Date(start.getTime() + 10_000)), /not owned/);

    // A later worker can reclaim an expired lease, but the attempt is counted.
    const reclaimed = await claimSolverJob(prisma, "worker-b", new Date(start.getTime() + 120_000), 60_000);
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, first.id);
    assert.equal(reclaimed.attemptCount, 2);
    assert.equal(await failSolverJob(prisma, reclaimed.id, "worker-b", "NATIVE_ABORT", "provider crashed", new Date(start.getTime() + 120_000)), "RETRY_WAIT");
    const retry = await claimSolverJob(prisma, "worker-c", new Date(start.getTime() + 8 * 60_000), 60_000);
    assert.ok(retry);
    assert.equal(await failSolverJob(prisma, retry.id, "worker-c", "NATIVE_ABORT", "provider crashed again", new Date(start.getTime() + 8 * 60_000)), "FAILED");
    assert.equal((await prisma.solverJob.findUniqueOrThrow({ where: { id: first.id } })).status, "FAILED");

    const complete = await claimSolverJob(prisma, "worker-d", start, 60_000);
    assert.ok(complete);
    assert.equal(complete.id, completeJobId);
    await prisma.solverRun.create({ data: { id: runId, jobId: completeJobId, attemptNumber: complete.attemptCount, status: "SUCCEEDED", resolvedInput: {}, outputSha256: `${suffix}_output` } });
    await completeSolverJob(prisma, completeJobId, "worker-d", runId, new Date(start.getTime() + 20_000));
    assert.equal((await prisma.solverJob.findUniqueOrThrow({ where: { id: completeJobId } })).status, "SUCCEEDED");
    await assert.rejects(() => completeSolverJob(prisma, completeJobId, "worker-e", runId), /not owned/);
  } finally {
    await prisma.solverJob.updateMany({ where: { id: { in: [retryJobId, completeJobId] } }, data: { successfulRunId: null } });
    await prisma.solverRun.deleteMany({ where: { id: runId } });
    await prisma.solverJob.deleteMany({ where: { id: { in: [retryJobId, completeJobId] } } });
    await prisma.solverTemplate.deleteMany({ where: { id: templateId } });
    await prisma.$disconnect();
  }
});
