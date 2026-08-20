/**
 * Server-only solution shape. This file is intentionally outside the shared
 * contracts package so frontend code cannot import GTO frequencies or reach.
 */
export type PrivateSolutionPayload = {
  schemaVersion: number;
  actionOrder: string[];
  byCombo: Record<string, { reachWeight: number; frequencies: Record<string, number> }>;
  reachedRanges: {
    hero: Record<string, number>;
    opponent: Record<string, number>;
  };
};
