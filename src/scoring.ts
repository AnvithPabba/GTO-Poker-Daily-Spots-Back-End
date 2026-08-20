export type MetricResult = {
  similarity: number;
  signedDifferences: number[];
  absoluteDifferences: number[];
};

export interface SimilarityMetric {
  key: string;
  version: number;
  score(predicted: number[], gto: number[]): MetricResult;
}

export const l1Metric: SimilarityMetric = {
  key: "l1",
  version: 1,
  score(predicted, gto) {
    if (predicted.length !== gto.length || predicted.length === 0) throw new Error("metric vectors must have equal non-zero length");
    const signedDifferences = predicted.map((value, index) => value - gto[index]!);
    const absoluteDifferences = signedDifferences.map((value) => Math.abs(value));
    const similarity = 100 * (1 - 0.5 * absoluteDifferences.reduce((sum, value) => sum + value / 10_000, 0));
    return { similarity: Math.max(0, Math.min(100, similarity)), signedDifferences, absoluteDifferences };
  },
};

const metrics = new Map<string, SimilarityMetric>([[`${l1Metric.key}:${l1Metric.version}`, l1Metric]]);

export function getSimilarityMetric(key: string, version: number): SimilarityMetric {
  const metric = metrics.get(`${key}:${version}`);
  if (!metric) throw new Error(`unknown similarity metric ${key}:${version}`);
  return metric;
}

export function scoreHands(actionOrder: string[], submitted: Record<string, number>, gto: Record<string, number>) {
  const predicted = actionOrder.map((action) => submitted[action] ?? 0);
  const solution = actionOrder.map((action) => gto[action] ?? 0);
  const result = l1Metric.score(predicted, solution);
  const majorityIndex = solution.reduce((best, value, index) => value > solution[best]! ? index : best, 0);
  return {
    similarity: result.similarity,
    gtoMajorityActionId: actionOrder[majorityIndex]!,
    actions: actionOrder.map((action, index) => ({
      actionId: action,
      submittedBasisPoints: predicted[index]!,
      gtoBasisPoints: solution[index]!,
      signedDifferenceBasisPoints: result.signedDifferences[index]!,
      absoluteDifferenceBasisPoints: result.absoluteDifferences[index]!,
    })),
  };
}
