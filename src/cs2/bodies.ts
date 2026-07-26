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
import { roleModel } from "./icons";
import { wrapEntity } from "@s2script/cs2";

/**
 * A corpse wears the uniform its owner was wearing.
 *
 * The C# read the victim's model off the pawn's skeleton instance, which is not exposed here — but
 * it no longer needs to be. Every player is put into a role uniform at assignment (see
 * `icons.roleModel`), so the model a player is wearing is a pure function of their role and the
 * corpse can reproduce it exactly rather than guessing from the team.
 *
 * This leaks nothing: Innocents and Traitors share the T uniform, and the Detective is public.
 *
 * These paths were previously `characters/models/...`, which contains no `.vmdl` at all — that is
 * why the ragdoll never rendered. See the header comment on `roleModel`.
 */

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
  // The uniforms are registered by `precacheRoleModels`; corpses reuse exactly those two models.
  void pc;
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
  const model = roleModel(role);

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
  // Collision and movement are configured below, after the spawn — see `configureCorpsePhysics`.
  const ragdoll = createEntity("prop_ragdoll");
  if (ragdoll === null) return null;

  if (!ragdoll.setModel(model)) console.warn(`[ttt] corpse model rejected: ${model}`);
  if (!ragdoll.spawn({ targetname: `ttt_body_${slot}` })) {
    ragdoll.remove();
    return null;
  }

  configureCorpsePhysics(ragdoll);

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
 * `COLLISION_GROUP_DEBRIS` — collides with the world, not with players or bullets.
 *
 * 5, NOT 6. This is not a schema enum (there is no `CollisionGroup_t`), so it is cross-checked
 * against two independent sources that agree: CounterStrikeSharp's `CollisionGroup` (implicit
 * numbering — NONE 0, NEVER, TRIGGER, CONDITIONALLY_SOLID, DEFAULT, DEBRIS = 5) and the schema's own
 * `ParticleCollisionGroup_t`, which mirrors the list with `PARTICLE_COLLISION_GROUP_DEBRIS = 0x5`.
 *
 * 6 is `COLLISION_GROUP_INTERACTIVE_DEBRIS`, which collides with everything EXCEPT other debris —
 * players included. Using it left corpses blocking movement, i.e. it silently did nothing.
 */
const COLLISION_GROUP_DEBRIS = 5;
/** `SolidType_t::SOLID_VPHYSICS` — collision comes from the physics model, which a ragdoll has. */
const SOLID_VPHYSICS = 6;
/** `MoveType_t::MOVETYPE_VPHYSICS` — the ragdoll simulates and settles. 5; 9 is MOVETYPE_LADDER. */
const MOVETYPE_VPHYSICS = 5;
/** `MoveType_t::MOVETYPE_FLY` — stops simulating, so a settled corpse stays put. 3; 5 is VPHYSICS. */
const MOVETYPE_FLY = 3;

/**
 * Make the corpse a piece of debris: solid to the world, transparent to players and bullets.
 *
 * This is the C# `BodySpawner` block that could not be ported before. `m_nSolidType` and `m_MoveType`
 * are ENUMS, which the codegen skipped wholesale for want of a byte width, and `m_Collision` is an
 * embedded struct, which it skipped as a class. All three are typed fields now.
 *
 * Without it a corpse used default collision and behaved like a wall: it blocked movement and ate
 * bullets, so a body lying in a doorway was cover and shooting past one was luck. DEBRIS keeps it
 * trace-hittable — identification still works — while letting players and shots through.
 *
 * Both collision groups are set, matching the C#: `m_Collision.m_collisionGroup` is what the engine
 * reads for most queries, `m_collisionAttribute.m_nCollisionGroup` is what VPhysics reads, and
 * setting only one leaves the two disagreeing.
 */
function configureCorpsePhysics(ref: EntityRef): void {
  const e = wrapEntity("CRagdollProp", ref);
  e.collision.collisionGroup = COLLISION_GROUP_DEBRIS;
  e.collision.collisionAttribute.collisionGroup = COLLISION_GROUP_DEBRIS;
  e.collision.solidType = SOLID_VPHYSICS;
  e.moveType = MOVETYPE_VPHYSICS;
}

/**
 * The `correctRagdoll` init pass, one world update after spawn.
 *
 * A `prop_ragdoll` comes up parented and draw-suppressed: model + `DispatchSpawn` alone leaves an
 * entity that is invisible AND has nothing to aim-trace against. Detaching it and re-placing it at
 * the position captured at spawn is what actually brings it into the world — this is the step the
 * port was missing, and its absence is why hiding the victim's pawn produced no corpse at all.
 *
 * It re-teleports to the body's OWN spawn origin rather than tracking the pawn: the ragdoll has
 * physics once it lands, so chasing anything after that would snap the corpse across the floor
 * every pass. Run only in the first fraction of a second, before it has travelled.
 */
export function settleBody(body: Body): void {
  if (!body.ref.isValid()) return;
  body.ref.acceptInput("ClearParent");
  // MOVETYPE_FLY before the teleport, exactly as `correctRagdoll` does: it takes the ragdoll out of
  // physics simulation so the placement below is final. Simulating meant the body could still drift
  // or be shoved after being positioned, which is what made corpses fight the settle passes.
  wrapEntity("CRagdollProp", body.ref).moveType = MOVETYPE_FLY;
  body.ref.teleport([body.x, body.y, body.z + 8], null, [0, 0, 0]);
}

/** Destroy one body's ragdoll and forget it. */
function removeBody(body: Body): void {
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

