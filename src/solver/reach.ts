/**
 * Minimum path reach for a concrete combo to be a meaningful training hand.
 *
 * Native CFR output can retain tiny positive probabilities after a combo has
 * effectively left the selected line. Those values are numerical residue and
 * must not become user-selectable hands.
 */
export const ACTIVE_COMBO_MIN_REACH = 1e-9;

export type ComboReach = {
  rawReach?: number | undefined;
  reachWeight: number;
};

export function effectiveComboReach(reach: ComboReach): number {
  return reach.rawReach ?? reach.reachWeight;
}

export function isActiveComboReach(reach: ComboReach): boolean {
  const value = effectiveComboReach(reach);
  return Number.isFinite(value) && value >= ACTIVE_COMBO_MIN_REACH;
}
