import { preflopContextSchema } from "@poker-trainer/contracts";
import { strategyDiversityReport, validateNormalizedEnvelope, type NormalizedEnvelope } from "./normalized.js";

type ProviderOptions = {
  spotId?: string;
  spotVersionId?: string;
  publicationDate?: string;
  slotOrder?: number;
  initialActor?: "ip" | "oop";
};

const cardPattern = /^[2-9TJQKA][cdhs]$/;
const comboPattern = /^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/;
const hashPattern = /^[a-f0-9]{64}$/;

function sourceHashFromProvider(source: unknown): string {
  if (!source || typeof source !== "object") throw new Error("provider envelope is missing public source metadata");
  const solveHash = (source as Record<string, unknown>).solveHash;
  if (typeof solveHash !== "string" || !solveHash.startsWith("sha256:") || !hashPattern.test(solveHash.slice(7))) throw new Error("provider solveHash must be sha256:<64 lowercase hex characters>");
  return solveHash.slice(7);
}

function asCard(value: unknown, path: string): string {
  if (typeof value !== "string" || !cardPattern.test(value)) throw new Error(`${path} contains an invalid card`);
  return value;
}

function streetForBoard(board: string[]): "flop" | "turn" | "river" {
  if (board.length === 3) return "flop";
  if (board.length === 4) return "turn";
  if (board.length === 5) return "river";
  throw new Error("provider board must contain three to five cards");
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function actionType(value: unknown, solverLabel: string): "check" | "bet" | "call" | "raise" | "fold" {
  if (value === "check" || value === "bet" || value === "call" || value === "raise" || value === "fold") return value;
  if (value === "allin" || value === "all-in") return /^RAISE\b/i.test(solverLabel) ? "raise" : "bet";
  throw new Error(`unsupported provider action type ${String(value)}`);
}

function comboCategory(combo: string): "pair" | "suited" | "offsuit" {
  const firstRank = combo[0];
  const secondRank = combo[2];
  const firstSuit = combo[1];
  const secondSuit = combo[3];
  if (firstRank === secondRank) return "pair";
  return firstSuit === secondSuit ? "suited" : "offsuit";
}

function comboVariants(combo: string): string[] {
  return [combo, `${combo.slice(2)}${combo.slice(0, 2)}`];
}

function basisPointFrequencies(value: unknown, actionOrder: string[], combo: string): Record<string, number> {
  if (!value || typeof value !== "object") throw new Error(`provider frequencies are missing for ${combo}`);
  const values = actionOrder.map((id) => {
    const number = (value as Record<string, unknown>)[id];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error(`provider frequency ${combo}.${id} is invalid`);
    return number;
  });
  const total = values.reduce((sum, number) => sum + number, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error(`provider frequencies total is invalid for ${combo}`);

  // Native floating-point vectors can total a few ulps above or below one.
  // Rounding each action independently and putting the correction on the
  // final action can turn a tiny positive frequency into -1 basis point.
  // Normalize first, floor every quota, then distribute the remaining points
  // by largest fractional remainder with action order as the stable tie-break.
  const quotas = values.map((number) => (number / total) * 10_000);
  const apportioned = quotas.map(Math.floor);
  const remaining = 10_000 - apportioned.reduce((sum, number) => sum + number, 0);
  const remainderOrder = quotas
    .map((quota, index) => ({ index, fraction: quota - apportioned[index]! }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let offset = 0; offset < remaining; offset += 1) {
    const index = remainderOrder[offset]!.index;
    apportioned[index] = apportioned[index]! + 1;
  }
  const result = Object.fromEntries(
    actionOrder.map((id, index) => [id, apportioned[index]!] as const),
  );
  return result;
}

function reachedCombos(rawRanges: unknown, actor: "ip" | "oop"): Record<string, number> {
  if (!rawRanges || typeof rawRanges !== "object") throw new Error("provider private ranges are missing");
  const player = (rawRanges as Record<string, unknown>)[actor];
  const combos = player && typeof player === "object" ? (player as Record<string, unknown>).combos : undefined;
  if (!combos || typeof combos !== "object") throw new Error(`provider reached range is missing for ${actor}`);
  return Object.fromEntries(Object.entries(combos).map(([combo, weight]) => {
    if (!weight || typeof weight !== "object") throw new Error(`provider reached combo ${combo} is malformed`);
    const normalized = (weight as Record<string, unknown>).normalizedReach;
    if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 0) throw new Error(`provider normalized reach ${actor}.${combo} is invalid`);
    return [combo, normalized];
  }));
}

function providerPath(source: Record<string, unknown>): string[] {
  const manifest = source.pathManifest;
  if (!manifest || typeof manifest !== "object") throw new Error("provider pathManifest is missing");
  const steps = (manifest as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) throw new Error("provider pathManifest.steps is missing");
  return ["root", ...steps.map((step) => {
    if (!step || typeof step !== "object") throw new Error("provider pathManifest step is malformed");
    const item = step as Record<string, unknown>;
    const label = item.solverLabel ?? item.card;
    if (typeof label !== "string" || !label) throw new Error("provider pathManifest step has no label");
    return label;
  })];
}

function positionsFromPreflop(preflop: ReturnType<typeof preflopContextSchema.parse>): Partial<Record<"ip" | "oop", string>> {
  if (preflop.status !== "known") return {};
  const result: Partial<Record<"ip" | "oop", string>> = {};
  for (const actor of ["ip", "oop"] as const) {
    const positions = [...new Set(preflop.actions.filter((action) => action.actor === actor).map((action) => action.position.trim()).filter(Boolean))];
    if (positions.length > 1) throw new Error(`provider preflop actions assign conflicting positions to ${actor}`);
    if (positions[0]) result[actor] = positions[0];
  }
  return result;
}

function isGenericLanePosition(value: string, actor: "ip" | "oop"): boolean {
  return value.toUpperCase() === actor.toUpperCase();
}

/**
 * Convert the native Solver Python envelope into the server's versioned
 * application envelope. This is the only provider-specific translation point;
 * API/database code consumes the normalized result below.
 */
export function normalizeProviderEnvelope(input: unknown, options: ProviderOptions = {}): NormalizedEnvelope {
  if (!input || typeof input !== "object") throw new Error("solver envelope must be an object");
  const root = input as Record<string, unknown>;
  const publicSource = root.publicPayload && typeof root.publicPayload === "object" ? (root.publicPayload as Record<string, unknown>).source : undefined;
  const privatePayload = root.privateSolutionPayload && typeof root.privateSolutionPayload === "object" ? root.privateSolutionPayload as Record<string, unknown> : undefined;
  if (!publicSource || !privatePayload || !root.publicPayload || typeof root.publicPayload !== "object") throw new Error("provider envelope requires publicPayload and privateSolutionPayload");
  const providerPublic = root.publicPayload as Record<string, unknown>;
  const source = publicSource as Record<string, unknown>;
  const sourceHash = sourceHashFromProvider(source);
  const rawConfigurationHash = source.configurationHash;
  let configurationHash: string | undefined;
  if (rawConfigurationHash !== undefined) {
    if (typeof rawConfigurationHash !== "string") throw new Error("provider configurationHash must be a sha256 hash");
    const normalizedConfigurationHash = rawConfigurationHash.startsWith("sha256:") ? rawConfigurationHash.slice(7) : rawConfigurationHash;
    if (!hashPattern.test(normalizedConfigurationHash)) throw new Error("provider configurationHash must be sha256:<64 lowercase hex> or 64 lowercase hex");
    configurationHash = normalizedConfigurationHash;
  }
  const spotId = typeof providerPublic.spotId === "string" ? providerPublic.spotId : options.spotId;
  const publicationDate = typeof providerPublic.publicationDate === "string" ? providerPublic.publicationDate : options.publicationDate;
  if (!spotId) throw new Error("spot ID is required (--spot-id)");
  if (!publicationDate) throw new Error("publication date is required (--publication-date)");
  const decisionRaw = providerPublic.decision;
  if (!decisionRaw || typeof decisionRaw !== "object") throw new Error("provider decision state is missing");
  const decision = decisionRaw as Record<string, unknown>;
  const board = Array.isArray(decision.board) ? decision.board.map((card, index) => asCard(card, `decision.board[${index}]`)) : [];
  const street = streetForBoard(board);
  const actor = decision.actor === "ip" || decision.actor === "oop" ? decision.actor : undefined;
  if (!actor) throw new Error("provider decision actor is invalid");
  const stacks = decision.stacks && typeof decision.stacks === "object" ? decision.stacks as Record<string, unknown> : {};
  const allIn = decision.allIn && typeof decision.allIn === "object" ? decision.allIn as Record<string, unknown> : {};
  const initialRaw = providerPublic.initialState && typeof providerPublic.initialState === "object" ? providerPublic.initialState as Record<string, unknown> : {};
  const initialBoard = Array.isArray(initialRaw.board) ? initialRaw.board.map((card, index) => asCard(card, `initialState.board[${index}]`)) : board;
  const effectiveStack = optionalNumber(initialRaw.effectiveStack) ?? optionalNumber(stacks.ip) ?? optionalNumber(stacks.oop) ?? 0;
  if (effectiveStack <= 0) throw new Error("provider effective stack is invalid");
  const firstHistoryAction = Array.isArray(providerPublic.history) ? providerPublic.history.find((event) => event && typeof event === "object" && (event as Record<string, unknown>).kind === "action") as Record<string, unknown> | undefined : undefined;
  const initialActor = options.initialActor ?? (firstHistoryAction?.actor === "ip" || firstHistoryAction?.actor === "oop" ? firstHistoryAction.actor : actor);
  const state = {
    board,
    pot: optionalNumber(decision.pot) ?? 0,
    stacks: { ip: optionalNumber(stacks.ip) ?? 0, oop: optionalNumber(stacks.oop) ?? 0 },
    street,
    actor,
    allIn: { ip: allIn.ip === true, oop: allIn.oop === true },
  };
  const initialState = {
    board: initialBoard,
    pot: optionalNumber(initialRaw.pot) ?? 0,
    stacks: { ip: effectiveStack, oop: effectiveStack },
    street: streetForBoard(initialBoard),
    actor: initialActor,
    allIn: { ip: false, oop: false },
  };
  const replayHistory = Array.isArray(providerPublic.history) ? providerPublic.history.map((event) => {
    if (!event || typeof event !== "object") throw new Error("provider history event is malformed");
    const item = event as Record<string, unknown>;
    if (item.kind === "deal") return { kind: "deal" as const, card: asCard(item.card, "history.card"), ...(typeof item.solverLabel === "string" ? { solverLabel: item.solverLabel } : {}) };
    const label = item.solverLabel;
    if (item.kind !== "action" || typeof label !== "string" || (item.actor !== "ip" && item.actor !== "oop")) throw new Error("provider history action is malformed");
    return { kind: "action" as const, actor: item.actor, actionType: actionType(item.actionType, label), solverLabel: label, ...(optionalNumber(item.amount) !== undefined ? { amount: optionalNumber(item.amount) } : {}), ...(optionalNumber(item.toAmount) !== undefined ? { toAmount: optionalNumber(item.toAmount) } : {}) };
  }) : [];
  const history = [...replayHistory, { kind: "decision" as const, actor }];
  const rawActions = providerPublic.legalActions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) throw new Error("provider legalActions are missing");
  const legalActions = rawActions.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`provider legal action ${index} is malformed`);
    const item = raw as Record<string, unknown>;
    const id = `a${index}`;
    const label = item.solverLabel;
    if (typeof label !== "string") throw new Error(`provider legal action ${index} has no solverLabel`);
    const result = { id, type: actionType(item.type, label), isAllIn: item.isAllIn === true, displayLabel: typeof item.displayLabel === "string" ? item.displayLabel : label, solverLabel: label } as Record<string, unknown>;
    if (optionalNumber(item.amount) !== undefined) result.amount = optionalNumber(item.amount);
    if (optionalNumber(item.toAmount) !== undefined) result.toAmount = optionalNumber(item.toAmount);
    return result;
  });
  const strategy = privatePayload.strategy && typeof privatePayload.strategy === "object" ? privatePayload.strategy as Record<string, unknown> : undefined;
  const actionOrder = Array.isArray(strategy?.actionOrder) ? strategy.actionOrder.map(String) : legalActions.map((action) => String(action.id));
  const rawByCombo = strategy?.byCombo;
  if (!rawByCombo || typeof rawByCombo !== "object") throw new Error("provider strategy.byCombo is missing");
  const requestedFeaturedCombo = typeof providerPublic.featuredCombo === "string" ? providerPublic.featuredCombo : Object.keys(rawByCombo)[0];
  if (!requestedFeaturedCombo) throw new Error("provider featured combo is missing");
  const byCombo = Object.fromEntries(Object.entries(rawByCombo).map(([combo, raw]) => {
    if (!raw || typeof raw !== "object") throw new Error(`provider strategy for ${combo} is malformed`);
    const item = raw as Record<string, unknown>;
    return [combo, { reachWeight: optionalNumber(item.reachWeight) ?? 0, frequencies: basisPointFrequencies(item.frequencies, actionOrder, combo) }];
  }));
  const hero = actor === "ip" ? "ip" : "oop";
  const opponent = hero === "ip" ? "oop" : "ip";
  const rawSelectable = Array.isArray(providerPublic.selectableCombos)
    ? providerPublic.selectableCombos.map((entry) => typeof entry === "string" ? entry : (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).combo === "string" ? (entry as Record<string, unknown>).combo as string : ""))
    : Object.keys(byCombo);
  const requestedCombos = Array.from(new Set([requestedFeaturedCombo, ...rawSelectable]));
  const selectableCombos = requestedCombos.map((combo) => {
    if (!comboPattern.test(combo)) throw new Error(`provider selectable combo is invalid: ${combo}`);
    const resolved = comboVariants(combo).find((variant) => Object.hasOwn(byCombo, variant));
    if (!resolved) throw new Error(`provider selectable combo ${combo} has no exact strategy entry`);
    return resolved;
  }).filter((combo, index, values) => values.indexOf(combo) === index);
  if (!selectableCombos.length) throw new Error("provider selectable combo catalog is empty");
  const featuredCombo = comboVariants(requestedFeaturedCombo).find((variant) => selectableCombos.includes(variant));
  if (!featuredCombo) throw new Error(`provider featured combo ${requestedFeaturedCombo} has no exact strategy entry`);
  const selectableStrategies = Object.fromEntries(selectableCombos.map((combo) => [combo, byCombo[combo]!])) as Record<string, { frequencies: Record<string, number> }>;
  const preflop = preflopContextSchema.parse(providerPublic.preflop ?? {
    status: "unknown",
    label: "Preflop start unavailable",
    summary: "This legacy solve did not preserve its preflop scenario.",
  });
  const preflopPositions = positionsFromPreflop(preflop);
  const rawPresentation = providerPublic.presentation && typeof providerPublic.presentation === "object" ? providerPublic.presentation as Record<string, unknown> : {};
  const positions = rawPresentation.positions && typeof rawPresentation.positions === "object" ? rawPresentation.positions as Record<string, unknown> : {};
  const resolvePosition = (laneActor: "ip" | "oop") => {
    const raw = typeof positions[laneActor] === "string" && positions[laneActor].length > 0 ? positions[laneActor] : undefined;
    const authored = preflopPositions[laneActor];
    if (raw && authored && !isGenericLanePosition(raw, laneActor) && raw.toUpperCase() !== authored.toUpperCase()) {
      throw new Error(`provider presentation position ${raw} conflicts with preflop position ${authored} for ${laneActor}`);
    }
    return authored ?? raw ?? laneActor.toUpperCase();
  };
  const resolvedPositions = { ip: resolvePosition("ip"), oop: resolvePosition("oop") };
  const buttonActors = (["ip", "oop"] as const).filter((laneActor) => resolvedPositions[laneActor].toUpperCase() === "BTN");
  if (buttonActors.length > 1) throw new Error("provider presentation assigns BTN to both players");
  const rawDealer = rawPresentation.dealerActor === "ip" || rawPresentation.dealerActor === "oop" ? rawPresentation.dealerActor : undefined;
  if (buttonActors[0] && rawDealer && rawDealer !== buttonActors[0]) {
    throw new Error(`provider dealer actor ${rawDealer} conflicts with BTN actor ${buttonActors[0]}`);
  }
  const presentation = {
    heroActor: hero,
    dealerActor: buttonActors[0] ?? rawDealer ?? initialActor,
    positions: resolvedPositions,
    holdingVisibility: "featured_hero" as const,
    chipUnit: rawPresentation.chipUnit === "currency" ? "currency" as const : "bb" as const,
  };
  const normalized = {
    schemaVersion: 3 as const,
    sourceHash,
    publicPayload: {
      schemaVersion: 3 as const,
      spotId,
      spotVersionId: typeof providerPublic.spotVersionId === "string" ? providerPublic.spotVersionId : (options.spotVersionId ?? `${spotId}_v1`),
      publicationDate,
      slotOrder: options.slotOrder ?? (typeof providerPublic.slotOrder === "number" ? providerPublic.slotOrder : 1),
      preflop,
      initialState,
      history,
      decision: state,
      legalActions,
      featuredCombo,
      selectableCombos: selectableCombos.map((combo) => ({ combo, category: comboCategory(combo) })),
      presentation,
    },
    privateSolutionPayload: {
      schemaVersion: 1,
      actionOrder,
      byCombo,
      reachedRanges: { hero: reachedCombos(privatePayload.ranges, hero), opponent: reachedCombos(privatePayload.ranges, opponent) },
    },
    candidateManifest: { sourceHash, path: providerPath(source), selectedCombo: featuredCombo, fallbackUsed: false, rankingVersion: "1" },
    provenance: {
      normalizerVersion: "provider-python-v3",
      selectionRankingVersion: "1",
      ...(configurationHash ? { configurationHash } : {}),
      strategyDiversity: strategyDiversityReport(actionOrder, selectableStrategies),
    },
  };
  return validateNormalizedEnvelope(normalized);
}
