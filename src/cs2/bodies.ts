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
 * Index lookup re-validates the stored `EntityRef` and evicts a mismatch — a recycled number is
 * not the corpse we recorded.
 */

import { cfg } from "../core/cvars";
import { Server } from "@s2script/sdk/server";
import { createEntity, type EntityRef } from "@s2script/sdk/entity";
import type { PrecacheContext } from "@s2script/sdk/sound";
import { MoveType, RoleId } from "../core/enums";
import { pawnOf, appliedModelOf } from "./pawn";
import { roleModel } from "./icons";
import { wrapEntity } from "@s2script/cs2";
import {
  allIndexedBodies,
  clearIndexedBodies,
  forgetIndexedBody,
  lookupBodyByIndex,
  lookupBodyByOwner,
  registerIndexedBody,
} from "./body-index";

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
  /**
   * Monotonic id minted at spawn. DNA cooldowns and any other per-corpse table must key on this,
   * not {@link index} — the engine recycles indexes.
   */
  id: number;
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

/** Next {@link Body.id}. Never reused, even across rounds, so a recycled index cannot collide. */
let nextBodyId = 1;

/** Register the corpse models for the current map. Call from `ctx.server.onPrecache`. */
export function precacheBodyModels(pc: PrecacheContext): void {
  // The uniforms are registered by `precacheRoleModels`; corpses reuse exactly those two models.
  void pc;
}

/** Every body created this round. DO NOT mutate. */
export function allBodies(): readonly Body[] {
  return allIndexedBodies() as readonly Body[];
}

/**
 * The body whose ragdoll has this entity index, or undefined.
 *
 * Evicts a stored record whose ref is dead or now names a different index — a recycled number is
 * not the corpse we recorded.
 */
export function bodyByEntity(index: number): Body | undefined {
  return lookupBodyByIndex(index) as Body | undefined;
}

/** The body belonging to `slot`, or undefined. */
export function bodyOfPlayer(slot: number): Body | undefined {
  return lookupBodyByOwner(slot) as Body | undefined;
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
  // Bisect switch — see `sm_ttt_bodies_enabled`.
  if (!cfg.bodiesEnabled) return null;
  const pawn = pawnOf(slot);
  if (pawn === null) return null;
  const origin = pawn.origin;
  if (origin === null) return null;
  const angles = pawn.angles;
  // The model the victim was ACTUALLY wearing, not the one their role implies.
  //
  // The C# reads it off the pawn's skeleton; nothing here exposes that, so this uses the model this
  // plugin last applied to them, falling back to the role's. The two normally agree — the role model
  // is what gets applied — but they come apart whenever the swap did not land: a role rewritten
  // between frames, a pawn that was stale when the deferred setModel ran, or a player whose model
  // was never swapped at all. Building a ragdoll from a model the pawn is not wearing is how the
  // corpse ends up as the wrong body, and a mismatched skeleton is a poor thing to network.
  const model = appliedModelOf(slot) ?? roleModel(role);

  // One corpse per player per round: an admin respawn mid-round would otherwise leave the old
  // ragdoll behind, and a second body for the same player breaks the identification bookkeeping.
  const previous = bodyOfPlayer(slot);
  if (previous !== undefined) removeBody(previous);

  // The model is a SPAWN KEYVALUE — create + DispatchSpawn in one call, model in place as it spawns.
  //
  // Both alternatives were tried live and both are wrong. `setModel` BEFORE spawn fired, on every
  // single death:
  //     skeletoninstance.cpp (5337) : Assertion Failed in function SetupModel():
  //     0 == ( pInstance->GetOwnerEntity()->GetEntityIdentity()->GetFlags() & EF_IN_STAGING_LIST )
  // which leaves a half-initialised skeletal entity to be networked, and clients hard-errored out
  // with `CopyExistingEntity: missing client entity N`. Moving `setModel` AFTER spawn removed the
  // assertion and replaced it with something worse: the ragdoll spawns with no model at all, and the
  // server took a SIGSEGV shortly after the next death.
  //
  // The C# can call SetModel before DispatchSpawn because it CLEARS the staging bit first
  // (`...Entity.Flags & ~(1 << 2)` in `BodySpawner.makeGameRagdoll`). Nothing here exposes a setter
  // for those flags — `EntityRef.identityFlags()` is read-only — so the keyvalue is the way to have
  // the model present at spawn without ever touching a staged entity.
  //
  // Collision and movement are configured below, after the spawn — see `configureCorpsePhysics`.
  // CREATE -> CLEAR THE STAGING BIT -> SET MODEL -> SPAWN. This is `BodySpawner.makeGameRagdoll`'s
  // ordering, and it is now reproducible here.
  //
  // The model used to be passed as a spawn keyvalue instead, because `setModel` asserts the entity is
  // NOT in the staging list and a created-but-unspawned entity always is — and at the time nothing
  // exposed a way to clear that bit. `EntityRef.clearIdentityFlags` exists for exactly this case now,
  // and its own documentation is explicit that the alternatives "produce half-initialised entities
  // that clients fail to copy". That is `CopyExistingEntity: missing client entity N`, the fatal that
  // has been dropping clients all session — and corpses are the path a prior bisect already
  // implicated ("bodies off = no crash"), with every captured crash index falling outside the set of
  // entities this plugin traces.
  //
  // The C# clears `1 << 2` (`...Entity.Flags & ~(1 << 2)`); the same bit is cleared here.
  const ragdoll = createEntity("prop_ragdoll");
  if (ragdoll === null) return null;
  ragdoll.clearIdentityFlags(EF_IN_STAGING_LIST);
  if (!ragdoll.setModel(model)) {
    // No model means a ragdoll that spawns broken and networks broken — refuse rather than ship it.
    ragdoll.acceptInput("Kill");
    return null;
  }
  if (!ragdoll.spawn({ targetname: `ttt_body_${slot}` })) {
    ragdoll.acceptInput("Kill");
    return null;
  }

  // ENTITY-INDEX TRACE — see the note in `removeIcons`. If a corpse claims an index a transmit-hidden
  // icon or glow prop just released, that is the suspected crash.
  console.log(`[ttt] t=${Server.gameTime.toFixed(2)} ENTTRACE make corpse slot=${String(slot)} index=${String(ragdoll.index)}`);

  configureCorpsePhysics(ragdoll);

  ragdoll.teleport(
    [origin.x, origin.y, origin.z + 8],
    angles === null ? null : [0, angles.y, 0],
    [0, 0, 0],
  );

  const body: Body = {
    id: nextBodyId++,
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
  registerIndexedBody(body);
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
/**
 * The staging-list bit on an entity's identity flags (`1 << 2`), cleared before `setModel` so a
 * created-but-unspawned ragdoll can take its model the way CS2's own body spawner does. The C#
 * writes `...Entity.Flags & ~(1 << 2)`.
 */
const EF_IN_STAGING_LIST = 1 << 2;

function configureCorpsePhysics(ref: EntityRef): void {
  const e = wrapEntity("CRagdollProp", ref);
  e.collision.collisionGroup = COLLISION_GROUP_DEBRIS;
  e.collision.collisionAttribute.collisionGroup = COLLISION_GROUP_DEBRIS;
  e.collision.solidType = SOLID_VPHYSICS;
  e.moveType = MoveType.VPhysics;
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
  wrapEntity("CRagdollProp", body.ref).moveType = MoveType.Fly;
  body.ref.teleport([body.x, body.y, body.z + 8], null, [0, 0, 0]);
}

/** Destroy one body's ragdoll and forget it. */
function removeBody(body: Body): void {
  // `Kill` input, not a direct remove: freeing an index immediately lets the engine recycle it
  // before clients are told the old entity died, which is what produces
  // `CopyExistingEntity: missing client entity N`. Matches the C#, which uses AcceptInput("Kill")
  // for every teardown.
  //
  // TRACED. The crash is an index RECYCLE — one entity freed, another handed the same index — so a
  // trace that records only creates can never show the pair. Four crash indices so far (613, 639,
  // 666, 670) fell in gaps between traced creates, which is exactly what a missing free record looks
  // like: the index was ours, we just never logged letting go of it.
  console.log(`[ttt] t=${Server.gameTime.toFixed(2)} ENTTRACE free corpse slot=${String(body.owner)} index=${String(body.index)}`);
  body.ref.acceptInput("Kill");
  forgetIndexedBody(body);
}

/** Drop every tracked body. `removeEntities` also deletes the ragdolls. */
export function clearBodies(removeEntities: boolean): void {
  if (removeEntities) {
    const list = allBodies();
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      console.log(`[ttt] t=${Server.gameTime.toFixed(2)} ENTTRACE free corpse slot=${String(b.owner)} index=${String(b.index)} (bulk)`);
      b.ref.acceptInput("Kill");
    }
  }
  clearIndexedBodies();
}

/**
 * The nearest un-identified body within `maxDistSq` of `slot`, or undefined.
 *
 * This is the fallback for body identification when an aim trace does not resolve to the ragdoll
 * (a corpse whose model failed to load has no collision to hit). Distances are compared squared —
 * no `sqrt`. Prefer the ragdoll's live `EntityRef.origin` (any entity, since sdk 0.21); the cached
 * spawn/carry position is only for a ref that has already gone stale.
 */
export function nearestBody(slot: number, maxDistSq: number): Body | undefined {
  const pawn = pawnOf(slot);
  if (pawn === null) return undefined;
  const o = pawn.origin;
  if (o === null) return undefined;

  let best: Body | undefined;
  let bestDist = maxDistSq;
  const list = allBodies();
  for (let i = 0; i < list.length; i++) {
    const b = list[i]!;
    const live = b.ref.isValid() ? b.ref.origin : null;
    const bx = live?.x ?? b.x;
    const by = live?.y ?? b.y;
    const bz = live?.z ?? b.z;
    const dx = o.x - bx;
    const dy = o.y - by;
    const dz = o.z - bz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

