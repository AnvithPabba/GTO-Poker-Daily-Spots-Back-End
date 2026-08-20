import { Prisma, SolverJobStatus, type PrismaClient } from "@prisma/client";
import { retryDelayMs } from "./template.js";

export type ClaimedSolverJob = {
  id: string;
  templateId: string;
  effectiveSeed: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
};

const DEFAULT_LEASE_MS = 60_000;

function leaseExpiry(now: Date, leaseMs: number): Date {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error("leaseMs must be at least 1000 milliseconds");
  return new Date(now.getTime() + leaseMs);
}

/**
 * Claim one queued/retryable or expired job for a host-native worker.
 * Serializable transactions make two workers converge safely; callers should
 * retry a Prisma serialization (P2034) error rather than executing twice.
 */
export async function claimSolverJob(
  prisma: PrismaClient,
  workerId: string,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
): Promise<ClaimedSolverJob | null> {
  if (!workerId || workerId.length > 128) throw new Error("workerId is required and must be at most 128 characters");
  const expires = leaseExpiry(now, leaseMs);
  try {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.solverJob.findFirst({
        where: {
          attemptCount: { lt: 3 },
          OR: [
            { status: SolverJobStatus.QUEUED, nextAttemptAt: { lte: now } },
            { status: SolverJobStatus.RETRY_WAIT, nextAttemptAt: { lte: now } },
            { status: SolverJobStatus.RUNNING, leaseExpiresAt: { lt: now } },
          ],
        },
        orderBy: [{ priority: "desc" }, { nextAttemptAt: "asc" }, { createdAt: "asc" }],
      });
      if (!job) return null;
      const updated = await tx.solverJob.update({
        where: { id: job.id },
        data: {
          status: SolverJobStatus.RUNNING,
          attemptCount: { increment: 1 },
          leaseOwner: workerId,
          leaseExpiresAt: expires,
          heartbeatAt: now,
          startedAt: job.startedAt ?? now,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      return { id: updated.id, templateId: updated.templateId, effectiveSeed: updated.effectiveSeed, attemptCount: updated.attemptCount, maxAttempts: updated.maxAttempts, leaseOwner: workerId, leaseExpiresAt: expires };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return null;
    throw error;
  }
}

export async function heartbeatSolverJob(prisma: PrismaClient, jobId: string, workerId: string, now = new Date(), leaseMs = DEFAULT_LEASE_MS): Promise<void> {
  const updated = await prisma.solverJob.updateMany({ where: { id: jobId, status: SolverJobStatus.RUNNING, leaseOwner: workerId }, data: { heartbeatAt: now, leaseExpiresAt: leaseExpiry(now, leaseMs) } });
  if (updated.count !== 1) throw new Error("solver job is not owned by this worker or is no longer running");
}

export async function completeSolverJob(prisma: PrismaClient, jobId: string, workerId: string, runId: string, now = new Date()): Promise<void> {
  const run = await prisma.solverRun.findFirst({ where: { id: runId, jobId }, select: { id: true } });
  if (!run) throw new Error("solver run does not belong to this job");
  const updated = await prisma.solverJob.updateMany({ where: { id: jobId, status: SolverJobStatus.RUNNING, leaseOwner: workerId }, data: { status: SolverJobStatus.SUCCEEDED, successfulRunId: runId, finishedAt: now, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null } });
  if (updated.count !== 1) throw new Error("solver job is not owned by this worker or is no longer running");
}

export async function failSolverJob(prisma: PrismaClient, jobId: string, workerId: string, code: string, message: string, now = new Date()): Promise<SolverJobStatus> {
  const job = await prisma.solverJob.findFirst({ where: { id: jobId, status: SolverJobStatus.RUNNING, leaseOwner: workerId }, select: { attemptCount: true, maxAttempts: true } });
  if (!job) throw new Error("solver job is not owned by this worker or is no longer running");
  const terminal = job.attemptCount >= job.maxAttempts;
  const status = terminal ? SolverJobStatus.FAILED : SolverJobStatus.RETRY_WAIT;
  await prisma.solverJob.update({ where: { id: jobId }, data: { status, nextAttemptAt: terminal ? now : new Date(now.getTime() + retryDelayMs(job.attemptCount)), lastErrorCode: code, lastErrorMessage: message, finishedAt: terminal ? now : null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null } });
  return status;
}
