import type { PrismaClient } from "@prisma/client";
import type { PgBoss, Job, JobResult } from "pg-boss";
import { SolverTemplateStatus } from "@prisma/client";
import { addPacificDays, countFutureCoverage, pacificDate, publishPacificDate } from "./publication.js";
import { enqueueSolverJob } from "./solver/template.js";
import { QUEUES, replenishmentPlan } from "./queue.js";

type ScheduledJob = { date?: string };

/** Register durable publication/replenishment handlers. Native solver jobs
 * remain in the solver-template queue for the host Mac worker. */
export async function installScheduledJobHandlers(boss: PgBoss, prisma: PrismaClient): Promise<void> {
  await boss.work<ScheduledJob>(QUEUES.publication, { batchSize: 1, perJobResults: true }, async (jobs): Promise<JobResult[]> => {
    return Promise.all(jobs.map(async (job: Job<ScheduledJob>) => {
      const date = job.data?.date ?? addPacificDays(pacificDate(), 1);
      try {
        const published = await publishPacificDate(prisma, date);
        return { id: job.id, status: "completed", output: { date, published: published.length } };
      } catch (error) {
        console.error(`publication job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { id: job.id, status: "failed", output: { message: error instanceof Error ? error.message : String(error) } };
      }
    }));
  });
  await boss.work<ScheduledJob>(QUEUES.replenishment, { batchSize: 1, perJobResults: true }, async (jobs): Promise<JobResult[]> => {
    return Promise.all(jobs.map(async (job: Job<ScheduledJob>) => {
      try {
        const coverage = await countFutureCoverage(prisma, pacificDate());
        const plan = replenishmentPlan(coverage);
        if (plan.alert) console.warn(`approved publication buffer alert: coverage ${coverage} is below 3`);
        if (plan.deficit > 0) {
          const templates = await prisma.solverTemplate.findMany({ where: { status: SolverTemplateStatus.ACTIVE }, orderBy: { createdAt: "asc" }, take: plan.deficit });
          for (const template of templates) await enqueueSolverJob(prisma, boss, template.id);
        }
        return { id: job.id, status: "completed", output: plan };
      } catch (error) {
        console.error(`replenishment job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { id: job.id, status: "failed", output: { message: error instanceof Error ? error.message : String(error) } };
      }
    }));
  });
}
