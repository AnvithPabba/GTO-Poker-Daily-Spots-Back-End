import { createHash } from "node:crypto";
import type { NormalizedEnvelope } from "./normalized.js";
import { ACTIVE_COMBO_MIN_REACH, effectiveComboReach } from "./reach.js";

export type CandidatePolicy = {
  preferredStreet?: "flop" | "turn" | "river";
  preferredActor?: "ip" | "oop";
  minimumReach?: number;
  minimumMixedActionBasisPoints?: number;
  minimumEntropy?: number;
  rankingVersion?: string;
};

export type RankedCandidate = {
  envelope: NormalizedEnvelope;
  score: number;
  preferredMatch: boolean;
  entropy: number;
  reach: number;
};

function entropy(values: number[]): number {
  const probabilities = values.map((value) => value / 10_000).filter((value) => value > 0);
  if (probabilities.length <= 1) return 0;
  const raw = -probabilities.reduce((sum, value) => sum + value * Math.log(value), 0);
  return raw / Math.log(values.length);
}

function tieBreak(seed: string, envelope: NormalizedEnvelope): number {
  return Number.parseInt(createHash("sha256").update(`${seed}:${envelope.candidateManifest.path.join("/")}:${envelope.candidateManifest.rankingVersion}`).digest("hex").slice(0, 12), 16);
}

export function rankCandidates(candidates: NormalizedEnvelope[], policy: CandidatePolicy, seed: string): RankedCandidate {
  const ranked = candidates.flatMap((envelope) => {
    const combo = envelope.candidateManifest.selectedCombo ?? envelope.publicPayload.featuredCombo;
    if (!combo) return [];
    const strategy = envelope.privateSolutionPayload.byCombo[combo];
    if (!strategy) return [];
    const reach = effectiveComboReach(strategy);
    if (reach < (policy.minimumReach ?? ACTIVE_COMBO_MIN_REACH)) return [];
    const frequencies = envelope.privateSolutionPayload.actionOrder.map((id) => strategy.frequencies[id] ?? 0);
    const mix = frequencies.filter((value) => value >= (policy.minimumMixedActionBasisPoints ?? 1)).length;
    const normalizedEntropy = entropy(frequencies);
    if (mix < 2 || normalizedEntropy < (policy.minimumEntropy ?? 0)) return [];
    const preferredMatch = (!policy.preferredStreet || envelope.publicPayload.decision.street === policy.preferredStreet)
      && (!policy.preferredActor || envelope.publicPayload.decision.actor === policy.preferredActor);
    const score = (preferredMatch ? 1_000 : 0) + normalizedEntropy * 100 + Math.min(reach, 1) * 10;
    return [{ envelope, score, preferredMatch, entropy: normalizedEntropy, reach, tie: tieBreak(seed, envelope) }];
  });
  if (!ranked.length) throw new Error("no valid mixed-strategy candidate");
  const preferred = ranked.some((candidate) => candidate.preferredMatch) ? ranked.filter((candidate) => candidate.preferredMatch) : ranked;
  preferred.sort((left, right) => right.score - left.score || left.tie - right.tie);
  const { tie: _tie, ...result } = preferred[0]!;
  return result;
}
