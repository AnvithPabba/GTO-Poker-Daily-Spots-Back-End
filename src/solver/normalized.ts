import { createHash } from "node:crypto";
import { z } from "zod";
import { publicSpotSchema, type PublicSpot } from "@poker-trainer/contracts";
import type { PrivateSolutionPayload } from "../private-solution.js";
import { isActiveComboReach } from "./reach.js";

const basis = z.number().int().min(0).max(10_000);
const privateComboSchema = z.object({
  rawReach: z.number().finite().nonnegative().optional(),
  reachWeight: z.number().finite().nonnegative(),
  frequencies: z.record(basis),
}).strict();

export const privateSolutionPayloadSchema = z.object({
  schemaVersion: z.number().int().positive(),
  actionOrder: z.array(z.string().regex(/^a\d+$/)).min(1),
  byCombo: z.record(privateComboSchema),
  reachedRanges: z.object({ hero: z.record(z.number().finite().nonnegative()), opponent: z.record(z.number().finite().nonnegative()) }).strict(),
  metric: z.object({ key: z.string().min(1), version: z.number().int().positive() }).strict().optional(),
}).strict();

export const candidateManifestSchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.array(z.string().min(1)),
  selectedCombo: z.string().regex(/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/).optional(),
  fallbackUsed: z.boolean().default(false),
  rankingVersion: z.string().min(1),
}).strict();

export const normalizedEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  publicPayload: publicSpotSchema,
  privateSolutionPayload: privateSolutionPayloadSchema,
  candidateManifest: candidateManifestSchema,
  provenance: z.object({
    normalizerVersion: z.string().min(1),
    selectionRankingVersion: z.string().min(1),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    solverRunId: z.string().optional(),
    strategyDiversity: z.object({
      comboCount: z.number().int().nonnegative(),
      distinctVectorCount: z.number().int().nonnegative(),
      distinctVectorRatio: z.number().finite().min(0).max(1),
      maxPairwiseL1BasisPoints: z.number().int().nonnegative(),
      uniformAcrossCombos: z.boolean(),
      warning: z.string().min(1).nullable(),
    }).strict().optional(),
  }).strict(),
}).strict();

export type NormalizedEnvelope = z.infer<typeof normalizedEnvelopeSchema>;

const forbiddenPublicKeys = new Set(["privateSolutionPayload", "gtoFrequencies", "frequencies", "reachedRanges", "reachWeight", "strategy", "solution"]);

function assertNoPrivateFields(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateFields(entry, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPublicKeys.has(key)) throw new Error(`public payload contains private field ${[...path, key].join(".")}`);
    assertNoPrivateFields(child, [...path, key]);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Summarize whether exact-combo strategy vectors actually differ.
 *
 * This is a diagnostic, not a correctness gate: a genuinely pure solve may
 * have one vector for every combo. It is persisted in provenance so an
 * operator can spot an accidentally uniform/native-provider output without
 * exposing any strategy values to the public API.
 */
export function strategyDiversityReport(
  actionOrder: string[],
  byCombo: Record<string, { frequencies: Record<string, number> }>,
) {
  const vectors = Object.values(byCombo).map((entry) => actionOrder.map((id) => entry.frequencies[id] ?? 0));
  const signatures = new Set(vectors.map((vector) => vector.join(",")));
  let maxPairwiseL1BasisPoints = 0;
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      const distance = vectors[left]!.reduce((sum, value, index) => sum + Math.abs(value - vectors[right]![index]!), 0);
      maxPairwiseL1BasisPoints = Math.max(maxPairwiseL1BasisPoints, distance);
    }
  }
  const comboCount = vectors.length;
  const distinctVectorCount = signatures.size;
  const uniformAcrossCombos = comboCount > 1 && distinctVectorCount === 1;
  return {
    comboCount,
    distinctVectorCount,
    distinctVectorRatio: comboCount === 0 ? 0 : distinctVectorCount / comboCount,
    maxPairwiseL1BasisPoints,
    uniformAcrossCombos,
    warning: uniformAcrossCombos ? "all selectable combos have the same strategy vector" : null,
  };
}

/**
 * Reject a native/provider result that has collapsed every selectable hand to
 * one identical action at a decision that is supposed to offer several
 * materially different choices.
 *
 * A two-action call/fold node can legitimately be pure across a narrow range,
 * so uniformity remains diagnostic there.  At a three-or-more-action node,
 * however, an exact 100% all-in vector for every reached combo is the failure
 * signature produced by the legacy TexasSolver v0.2.0 solve that prompted
 * this guard.  Such a spot is also unsuitable as a daily mixed-strategy
 * exercise even if a future provider were to produce it legitimately.
 */
export function assertPublishableStrategyQuality(envelope: NormalizedEnvelope): void {
  const report = strategyDiversityReport(
    envelope.privateSolutionPayload.actionOrder,
    envelope.privateSolutionPayload.byCombo,
  );
  if (!report.uniformAcrossCombos) return;

  const firstCombo = envelope.publicPayload.selectableCombos[0]?.combo;
  const first = firstCombo ? envelope.privateSolutionPayload.byCombo[firstCombo] : undefined;
  if (!first) throw new Error("normalized spot has no selectable strategy combo");
  const dominant = envelope.privateSolutionPayload.actionOrder.find((id) => first.frequencies[id] === 10_000);
  const action = envelope.publicPayload.legalActions.find((candidate) => candidate.id === dominant);
  // Range-wide pure checks/bets can be a legitimate equilibrium; range size
  // alone is not a provider-failure signal. The reproducible legacy failure
  // makes every reached combo choose an all-in action. Reject that signature
  // when the node has several alternatives or a substantial selectable range.
  // A small two-action all-in call/fold node may still be legitimately pure.
  const suspiciousUniformAllIn = Boolean(action?.isAllIn)
    && (envelope.publicPayload.legalActions.length >= 3 || report.comboCount >= 20);
  if (suspiciousUniformAllIn) {
    const dominantLabel = action?.displayLabel ?? dominant ?? "unknown action";
    throw new Error(
      `solver strategy quality failed: all ${report.comboCount} selectable combos use the same 100% ${dominantLabel} vector across ${envelope.publicPayload.legalActions.length} legal actions`,
    );
  }
}

export function validateNormalizedEnvelope(input: unknown): NormalizedEnvelope {
  const envelope = normalizedEnvelopeSchema.parse(input);
  assertNoPrivateFields(envelope.publicPayload);
  if (envelope.publicPayload.preflop.status === "known") {
    const authoredPositions: Partial<Record<"ip" | "oop", string>> = {};
    for (const actor of ["ip", "oop"] as const) {
      const positions = [...new Set(envelope.publicPayload.preflop.actions.filter((action) => action.actor === actor).map((action) => action.position.toUpperCase()))];
      if (positions.length > 1) throw new Error(`preflop actions assign conflicting positions to ${actor}`);
      if (positions[0]) authoredPositions[actor] = positions[0];
      if (positions[0] && envelope.publicPayload.presentation.positions[actor].toUpperCase() !== positions[0]) {
        throw new Error(`presentation position for ${actor} does not match preflop actions`);
      }
    }
    const buttonActors = (["ip", "oop"] as const).filter((actor) => authoredPositions[actor] === "BTN");
    if (buttonActors.length > 1) throw new Error("preflop actions assign BTN to both players");
    if (buttonActors[0] && envelope.publicPayload.presentation.dealerActor !== buttonActors[0]) {
      throw new Error("presentation dealer actor does not match BTN position");
    }
  }
  if (envelope.candidateManifest.sourceHash !== envelope.sourceHash) throw new Error("candidate manifest source hash mismatch");
  const publicActionIds = envelope.publicPayload.legalActions.map((action) => action.id);
  if (JSON.stringify(publicActionIds) !== JSON.stringify(envelope.privateSolutionPayload.actionOrder)) throw new Error("public/private action order mismatch");
  const selectable = new Set(envelope.publicPayload.selectableCombos.map((entry) => entry.combo));
  for (const combo of selectable) {
    const strategy = envelope.privateSolutionPayload.byCombo[combo];
    if (!strategy) throw new Error(`missing private strategy for selectable combo ${combo}`);
    const ids = Object.keys(strategy.frequencies);
    if (ids.length !== publicActionIds.length || ids.some((id) => !publicActionIds.includes(id))) throw new Error(`strategy action mismatch for ${combo}`);
    if (Object.values(strategy.frequencies).reduce((sum, value) => sum + value, 0) !== 10_000) throw new Error(`strategy frequencies must total 10000 for ${combo}`);
    if (!isActiveComboReach(strategy)) throw new Error(`selectable combo ${combo} has inactive reach`);
  }
  const privateCombos = new Set(Object.keys(envelope.privateSolutionPayload.byCombo));
  if (privateCombos.size !== selectable.size || [...privateCombos].some((combo) => !selectable.has(combo))) {
    throw new Error("private strategy combos must exactly match public selectable combos");
  }
  if (envelope.provenance.strategyDiversity) {
    const report = envelope.provenance.strategyDiversity;
    if (report.comboCount !== selectable.size) {
      throw new Error("strategy diversity combo count does not match selectable combos");
    }
  }
  return envelope;
}

export function asPrivateSolutionPayload(envelope: NormalizedEnvelope): PrivateSolutionPayload {
  return envelope.privateSolutionPayload as PrivateSolutionPayload;
}
