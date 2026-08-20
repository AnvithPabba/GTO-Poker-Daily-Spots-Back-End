import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, SolverJobStatus, SolverTemplateStatus, type PrismaClient } from "@prisma/client";
import type { PgBoss } from "pg-boss";

const card = z.string().regex(/^[2-9TJQKA][cdhs]$/);

/**
 * The native solver configuration is deliberately kept as JSON. These checks
 * protect the queue from impossible inputs without coupling the TypeScript
 * service to every provider-specific solver field.
 */
export const solverTemplateConfigSchema = z.record(z.unknown()).superRefine((config, context) => {
  const pot = config.pot;
  const stack = config.effective_stack ?? config.effectiveStack;
  const board = config.board;
  if (typeof pot !== "number" || !Number.isFinite(pot) || pot < 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pot"], message: "pot must be a non-negative number" });
  }
  if (typeof stack !== "number" || !Number.isFinite(stack) || stack <= 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effective_stack"], message: "effective_stack must be positive" });
  }
  if (!Array.isArray(board) || (board.length !== 3 && board.length !== 4 && board.length !== 5)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["board"], message: "board must contain 3–5 cards" });
  } else {
    const cards = board.filter((entry): entry is string => typeof entry === "string");
    if (cards.length !== board.length || cards.some((entry) => !card.safeParse(entry).success)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["board"], message: "board contains an invalid card" });
    }
    if (new Set(cards).size !== cards.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["board"], message: "board cards must be unique" });
    }
  }
  if (!config.range_profile && !config.ranges) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["range_profile"], message: "range_profile or ranges is required" });
  }
});

export type SolverTemplateConfig = z.infer<typeof solverTemplateConfigSchema>;

export type CreateTemplateInput = {
  familyId: string;
  version: number;
  name: string;
  description?: string;
  tags?: unknown;
  config: unknown;
  selectionRankingVersion?: string;
  defaultSeed?: string;
};

export function validateTemplateConfig(value: unknown): SolverTemplateConfig {
  return solverTemplateConfigSchema.parse(value);
}

export function deterministicSeed(templateId: string, configuredSeed?: string): string {
  return createHash("sha256").update(`${templateId}:${configuredSeed ?? "default"}`).digest("hex");
}

export async function createSolverTemplate(prisma: PrismaClient, input: CreateTemplateInput) {
  const config = validateTemplateConfig(input.config);
  return prisma.solverTemplate.create({
    data: {
      familyId: input.familyId,
      version: input.version,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined ? { tags: input.tags as Prisma.InputJsonValue } : {}),
      config: config as Prisma.InputJsonValue,
      selectionRankingVersion: input.selectionRankingVersion ?? "1",
      defaultSeed: input.defaultSeed ?? null,
      status: SolverTemplateStatus.ACTIVE,
    },
  });
}

export async function enqueueSolverJob(
  prisma: PrismaClient,
  boss: PgBoss,
  templateId: string,
  options: { priority?: number; seed?: string } = {},
) {
  const template = await prisma.solverTemplate.findUniqueOrThrow({ where: { id: templateId } });
  if (template.status !== SolverTemplateStatus.ACTIVE) {
    throw new Error(`template ${templateId} is not active`);
  }
  const effectiveSeed = deterministicSeed(template.id, options.seed ?? template.defaultSeed ?? undefined);
  const job = await prisma.solverJob.create({
    data: {
      templateId,
      effectiveSeed,
      priority: options.priority ?? 0,
      status: SolverJobStatus.QUEUED,
      maxAttempts: 3,
    },
  });
  try {
    const pgBossJobId = await boss.send("solver-template", { jobId: job.id, templateId, effectiveSeed }, { priority: options.priority ?? 0 });
    return pgBossJobId ? prisma.solverJob.update({ where: { id: job.id }, data: { pgBossJobId } }) : job;
  } catch (error) {
    await prisma.solverJob.update({ where: { id: job.id }, data: { status: SolverJobStatus.FAILED, lastErrorCode: "QUEUE_SEND_FAILED", lastErrorMessage: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export function retryDelayMs(attemptNumber: number): number {
  if (attemptNumber <= 1) return 60_000;
  return 300_000;
}
