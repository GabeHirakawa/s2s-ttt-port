/**
 * Fail-closed identity for anything we keyed by a raw entity index.
 *
 * An index is recycled the moment the engine frees it. A stored `EntityRef` still knows the
 * serial it was minted for, so `isValid()` plus a live index match is what distinguishes "this is
 * still the corpse/prop/smoke we recorded" from "something else is wearing that number now."
 */

/** The slice of `EntityRef` an index ledger needs. */
export interface IndexRef {
  isValid(): boolean;
  readonly index: number;
}

/** True when `ref` is still the entity that occupied `index` at record time. */
export function refOwnsIndex(ref: IndexRef, index: number): boolean {
  return ref.isValid() && ref.index === index;
}
