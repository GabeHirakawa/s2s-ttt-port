/**
 * Corpses — the port of `IBody`, `CS2Body`, `BodySpawner`, `BodyTracker` and `BodyPickupListener`.
 *
 * A TTT corpse is a `prop_ragdoll` spawned where the victim fell. Looking at it and pressing USE
 * identifies it, revealing the dead player's role server-wide and ending the "still alive" illusion
 * TTT keeps up until a body is found.
 *
 * The C# tracker kept an `IDictionary<IBody, CRagdollProp>` keyed by the body *object*, so every
 * lookup hashed a reference and then re-resolved the entity through `Utilities.GetEntityFromIndex`.
 * Here bodies sit in a flat array with two `Map` indexes (by ragdoll entity index, by owner slot),
 * and each body caches its own spawn position so proximity checks never touch the entity at all.
 */

import { createEntity, type EntityRef } from "@s2script/sdk/entity";
import type { PrecacheContext } from "@s2script/sdk/sound";
import { RoleId } from "../core/enums";
import { pawnOf } from "./pawn";

/**
 * Player models used for corpses.
 *
 * The C# build copied the victim's own model off the pawn's skeleton instance
 * (`CBodyComponent.SceneNode.GetSkeletonInstance().ModelState.ModelName`); that path is not exposed
 * through the s2script schema, so a corpse gets the stock model for the role it died in. Visually
 * this differs from the original only for players wearing non-default agents.
 *
 * These are deliberately the SAME two paths `cs2/icons.ts` dresses the living in: now that every
 * player wears a role uniform, a corpse spawned with any other model would not look like the player
 * it came from — most visibly for the Detective, whose body is the one thing everyone goes looking
 * for.
 */
const MODEL_T = "characters/models/tm_phoenix/tm_phoenix.vmdl";
const MODEL_CT = "characters/models/ctm_fbi/ctm_fbi_varianth.vmdl";

/** A dead player's corpse. */
export interface Body {
  /** The ragdoll entity. Goes stale when the round restarts. */
  ref: EntityRef;
  /** Entity index of the ragdoll — what a hit trace is matched against. */
  index: number;
  /** Slot of the player this body belongs to. */
  owner: number;
  /** Cached owner name (they may disconnect before anyone finds the body). */
  ownerName: string;
  /** Role the owner held; revealed on identification. */
  ownerRole: RoleId;
  /** Slot of whoever killed them, or -1. */
  killer: number;
  /** Cached killer name at time of death. */
  killerName: string;
  /** Weapon class used for the kill. */
  weapon: string;
  /** Has someone identified this body yet? */
  identified: boolean;
  /** Server time (seconds) of death — DNA decay is measured from this. */
  timeOfDeath: number;
  /** True when the killer wore Gloves, suppressing the DNA trace. */
  dnaSuppressed: boolean;
  /** True once Body Paint made it *look* identified without revealing anything. */
  painted: boolean;
  /** Cached world position — avoids reading the entity for every proximity/compass check. */
  x: number;
  y: number;
  z: number;
}

const bodies: Body[] = [];
const byIndex = new Map<number, Body>();
const byOwner = new Map<number, Body>();

/** Register the corpse models for the current map. Call from `ctx.server.onPrecache`. */
export function precacheBodyModels(pc: PrecacheContext): void {
  pc.add(MODEL_T);
  pc.add(MODEL_CT);
}

/** Every body created this round. DO NOT mutate. */
export function allBodies(): readonly Body[] {
  return bodies;
}

/** The body whose ragdoll has this entity index, or undefined. */
export function bodyByEntity(index: number): Body | undefined {
  return byIndex.get(index);
}

/** The body belonging to `slot`, or undefined. */
export function bodyOfPlayer(slot: number): Body | undefined {
  return byOwner.get(slot);
}

/**
 * Spawn a ragdoll where `slot`'s pawn is standing and register it as a body. Returns null when the
 * pawn is already gone (a disconnect racing the death event).
 */
export function spawnBody(
  slot: number,
  ownerName: string,
  role: RoleId,
  killer: number,
  killerName: string,
  weapon: string,
  gameTime: number,
): Body | null {
  const pawn = pawnOf(slot);
  if (pawn === null) return null;
  const origin = pawn.origin;
  if (origin === null) return null;
  const angles = pawn.angles;
  // Picked by ROLE, exactly as `icons.ts::applyRoleModel` picks the living player's uniform. Team
  // gives the same answer for the whole of a live round (Detective on CT, everyone else on T), but
  // not once `revealAsInnocent` has started moving found Innocents across at the end of one.
  const model = role === RoleId.Detective ? MODEL_CT : MODEL_T;

  // One corpse per player per round: an admin respawn mid-round would otherwise leave the old
  // ragdoll behind, and a second body for the same player breaks the identification bookkeeping.
  const previous = bodyOfPlayer(slot);
  if (previous !== undefined) removeBody(previous);

  // Create -> setModel -> spawn, in that order.
  //
  // A `prop_ragdoll` must have its model set BEFORE `DispatchSpawn`: spawning one with no resolved
  // model leaves it with no physics representation and the engine tears it down again a moment
  // later (it reads as created, then goes invalid). Passing `model` as a spawn keyvalue is not
  // equivalent. This is the order the C# `BodySpawner` used, and it needs `EntityRef.setModel`,
  // which only resolves from runtime v0.4.0 onward.
  //
  // NOTE: the ragdoll keeps its default collision. The C# set the collision group to DEBRIS (so a
  // corpse blocks neither movement nor bullets while staying trace-hittable); that field is not
  // reachable through the s2script schema.
  const ragdoll = createEntity("prop_ragdoll");
  if (ragdoll === null) return null;

  if (!ragdoll.setModel(model)) console.log(`[ttt] WARN: corpse model rejected: ${model}`);
  if (!ragdoll.spawn({ targetname: `ttt_body_${slot}` })) {
    ragdoll.remove();
    return null;
  }

  ragdoll.teleport(
    [origin.x, origin.y, origin.z + 8],
    angles === null ? null : [0, angles.y, 0],
    [0, 0, 0],
  );

  const body: Body = {
    ref: ragdoll,
    index: ragdoll.index,
    owner: slot,
    ownerName,
    ownerRole: role,
    killer,
    killerName,
    weapon,
    identified: false,
    timeOfDeath: gameTime,
    dnaSuppressed: false,
    painted: false,
    x: origin.x,
    y: origin.y,
    z: origin.z,
  };
  bodies.push(body);
  byIndex.set(body.index, body);
  byOwner.set(slot, body);
  return body;
}

/**
 * Destroy one body's ragdoll and forget it.
 *
 * Exported because `combat.ts` has to undo a corpse a `bodyCreate` listener cancelled: removing only
 * the entity would leave the `Body` record in `bodies`/`byIndex`/`byOwner`, where `nearestBody`
 * still hands it out as an invisible, un-identifiable corpse.
 */
export function removeBody(body: Body): void {
  body.ref.remove();
  byIndex.delete(body.index);
  if (byOwner.get(body.owner) === body) byOwner.delete(body.owner);
  const i = bodies.indexOf(body);
  if (i >= 0) bodies.splice(i, 1);
}

/** Drop every tracked body. `removeEntities` also deletes the ragdolls. */
export function clearBodies(removeEntities: boolean): void {
  if (removeEntities) for (let i = 0; i < bodies.length; i++) bodies[i]!.ref.remove();
  bodies.length = 0;
  byIndex.clear();
  byOwner.clear();
}

/**
 * The nearest un-identified body within `maxDistSq` of `slot`, or undefined.
 *
 * This is the fallback for body identification when an aim trace does not resolve to the ragdoll
 * (a corpse whose model failed to load has no collision to hit). Distances are compared squared —
 * no `sqrt` — against the body's cached spawn position.
 */
export function nearestBody(slot: number, maxDistSq: number): Body | undefined {
  const pawn = pawnOf(slot);
  if (pawn === null) return undefined;
  const o = pawn.origin;
  if (o === null) return undefined;

  let best: Body | undefined;
  let bestDist = maxDistSq;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    const dx = o.x - b.x;
    const dy = o.y - b.y;
    const dz = o.z - b.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

