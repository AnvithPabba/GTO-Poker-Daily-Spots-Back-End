export type SolverQualityCheckpoint = { iteration: number; totalPercent: number };

export type SolverQualityReport = {
  minimumIterations: number;
  targetExploitabilityPercent: number;
  checkpoints: SolverQualityCheckpoint[];
  lastObservedIteration: number | null;
  lastObservedTotalPercent: number | null;
  lastIteration: number | null;
  lastTotalPercent: number | null;
  minimumReached: boolean;
  converged: boolean;
};

export class SolverQualityError extends Error {
  public constructor(message: string, public readonly report?: SolverQualityReport) {
    super(message);
    this.name = "SolverQualityError";
  }
}

const iterationPattern = /^\s*Iter:\s*(\d+)\s*$/i;
const totalPattern = /Total\s+exploitability\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(?:percent|precent|%)?/i;

export function parseSolverLog(log: string): SolverQualityCheckpoint[] {
  if (typeof log !== "string") throw new SolverQualityError("solver log must be text");
  const checkpoints: SolverQualityCheckpoint[] = [];
  let iteration: number | undefined;
  for (const line of log.split(/\r?\n/)) {
    const iterationMatch = iterationPattern.exec(line);
    if (iterationMatch) {
      iteration = Number(iterationMatch[1]);
      continue;
    }
    const totalMatch = totalPattern.exec(line);
    if (!totalMatch || iteration === undefined) continue;
    const totalPercent = Number(totalMatch[1]);
    if (Number.isFinite(totalPercent) && totalPercent >= 0) checkpoints.push({ iteration, totalPercent });
  }
  return checkpoints;
}

export function assessSolverLog(log: string, settings: { minimumIterations: number; accuracyPercent: number }): SolverQualityReport {
  const minimumIterations = settings.minimumIterations;
  const targetExploitabilityPercent = settings.accuracyPercent;
  if (!Number.isInteger(minimumIterations) || minimumIterations < 1 || !Number.isFinite(targetExploitabilityPercent) || targetExploitabilityPercent <= 0) {
    throw new SolverQualityError("solver quality settings are invalid");
  }
  const checkpoints = parseSolverLog(log);
  const eligible = checkpoints.filter((checkpoint) => checkpoint.iteration >= minimumIterations);
  const latest = eligible.at(-1) ?? null;
  const observed = checkpoints.at(-1) ?? null;
  const report: SolverQualityReport = {
    minimumIterations,
    targetExploitabilityPercent,
    checkpoints,
    lastObservedIteration: observed?.iteration ?? null,
    lastObservedTotalPercent: observed?.totalPercent ?? null,
    lastIteration: latest?.iteration ?? null,
    lastTotalPercent: latest?.totalPercent ?? null,
    minimumReached: latest !== null,
    converged: latest !== null && latest.totalPercent <= targetExploitabilityPercent,
  };
  if (!report.minimumReached) throw new SolverQualityError(`solver stopped before minimum iteration ${minimumIterations}`, report);
  if (!report.converged) throw new SolverQualityError(`solver exploitability ${latest!.totalPercent}% exceeds target ${targetExploitabilityPercent}%`, report);
  return report;
}
