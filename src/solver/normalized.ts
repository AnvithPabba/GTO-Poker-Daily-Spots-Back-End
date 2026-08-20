import { createHash } from "node:crypto";
import { z } from "zod";
import { publicSpotSchema, type PublicSpot } from "@poker-trainer/contracts";
import type { PrivateSolutionPayload } from "../private-solution.js";

const basis = z.number().int().min(0).max(10_000);
const privateComboSchema = z.object({
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
  schemaVersion: z.literal(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  publicPayload: publicSpotSchema,
  privateSolutionPayload: privateSolutionPayloadSchema,
  candidateManifest: candidateManifestSchema,
  provenance: z.object({
    normalizerVersion: z.string().min(1),
    selectionRankingVersion: z.string().min(1),
    solverRunId: z.string().optional(),
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

export function validateNormalizedEnvelope(input: unknown): NormalizedEnvelope {
  const envelope = normalizedEnvelopeSchema.parse(input);
  assertNoPrivateFields(envelope.publicPayload);
  if (envelope.candidateManifest.sourceHash !== envelope.sourceHash) throw new Error("candidate manifest source hash mismatch");
  const publicActionIds = envelope.publicPayload.legalActions.map((action) => action.id);
  if (JSON.stringify(publicActionIds) !== JSON.stringify(envelope.privateSolutionPayload.actionOrder)) throw new Error("public/private action order mismatch");
  const selectable = new Set(envelope.publicPayload.mode === "single_hand" ? (envelope.publicPayload.featuredCombo ? [envelope.publicPayload.featuredCombo] : []) : (envelope.publicPayload.selectableCombos ?? []).map((entry) => entry.combo));
  for (const combo of selectable) {
    const strategy = envelope.privateSolutionPayload.byCombo[combo];
    if (!strategy) throw new Error(`missing private strategy for selectable combo ${combo}`);
    const ids = Object.keys(strategy.frequencies);
    if (ids.length !== publicActionIds.length || ids.some((id) => !publicActionIds.includes(id))) throw new Error(`strategy action mismatch for ${combo}`);
    if (Object.values(strategy.frequencies).reduce((sum, value) => sum + value, 0) !== 10_000) throw new Error(`strategy frequencies must total 10000 for ${combo}`);
  }
  return envelope;
}

export function asPrivateSolutionPayload(envelope: NormalizedEnvelope): PrivateSolutionPayload {
  return envelope.privateSolutionPayload as PrivateSolutionPayload;
}
