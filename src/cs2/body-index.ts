/**
 * Body ledger keyed by ragdoll index and owner slot.
 *
 * Lookups by raw index re-validate the stored ref and evict a mismatch — a recycled index is not
 * the corpse we recorded. Lives in its own file so the eviction can be unit-tested without
 * importing the engine-backed spawner.
 */

import { refOwnsIndex, type IndexRef } from "../core/index-identity";

/** The fields the index maps need. `Body` satisfies this. */
export interface BodyIndexRecord {
  ref: IndexRef;
  index: number;
  owner: number;
}

const bodies: BodyIndexRecord[] = [];
const byIndex = new Map<number, BodyIndexRecord>();
const byOwner = new Map<number, BodyIndexRecord>();

/** Every tracked body. DO NOT mutate. */
export function allIndexedBodies(): readonly BodyIndexRecord[] {
  return bodies;
}

/** Remember a newly spawned body. */
export function registerIndexedBody(body: BodyIndexRecord): void {
  bodies.push(body);
  byIndex.set(body.index, body);
  byOwner.set(body.owner, body);
}

/** Drop one record from every map. Does not `Kill` the ragdoll. */
export function forgetIndexedBody(body: BodyIndexRecord): void {
  if (byIndex.get(body.index) === body) byIndex.delete(body.index);
  if (byOwner.get(body.owner) === body) byOwner.delete(body.owner);
  const i = bodies.indexOf(body);
  if (i >= 0) bodies.splice(i, 1);
}

/** Drop every record. Does not `Kill` ragdolls. */
export function clearIndexedBodies(): void {
  bodies.length = 0;
  byIndex.clear();
  byOwner.clear();
}

/**
 * The body whose ragdoll has this entity index, or undefined.
 *
 * A stored record whose ref is dead or now names a different index is evicted — the engine has
 * recycled the number and this is no longer our corpse.
 */
export function lookupBodyByIndex(index: number): BodyIndexRecord | undefined {
  const body = byIndex.get(index);
  if (body === undefined) return undefined;
  if (refOwnsIndex(body.ref, index)) return body;
  if (byIndex.get(index) === body) byIndex.delete(index);
  forgetIndexedBody(body);
  return undefined;
}

/** The body belonging to `slot`, or undefined. */
export function lookupBodyByOwner(slot: number): BodyIndexRecord | undefined {
  return byOwner.get(slot);
}
