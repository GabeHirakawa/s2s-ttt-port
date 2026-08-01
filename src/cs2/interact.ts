/**
 * The USE key — the port of `PropMover` and `BodyPickupListener`.
 *
 * Holding USE while looking at a corpse identifies it; holding it on a physics prop carries the
 * prop; holding it on a tripwire defuses it.
 *
 * The C# `PropMover` did all this from `OnTick` **plus** a second `AddTimer(Server.TickInterval)`
 * repeating timer **plus** an `OnPlayerButtonsChanged` listener, and ran a fresh
 * `GetGameTraceByEyePosition` ray for every player every tick regardless of whether anyone was
 * holding USE. Here the button state is read from the pawn (already in memory), and a ray is cast
 * only for players who are actually pressing USE — typically nobody.
 */

import { nextFrame } from "@s2script/sdk/timers";
import { Trace, TraceMask } from "@s2script/sdk/trace";
import { Vector, forwardVector } from "@s2script/sdk/math";
import { Server } from "@s2script/sdk/server";
import { Entity, type EntityRef } from "@s2script/sdk/entity";
import { Beam, type BeamHandle } from "@s2script/cs2";
import { Button, GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { cfg, n } from "../core/cvars";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf } from "./pawn";
import { bodyByEntity, nearestBody, type Body } from "./bodies";
import { hasBodyPaint, spendBodyPaint, spendGlove, hasGloves, tryDefuseTripwire } from "../shop/effects";
import { readDna } from "../shop/weaponfx";
import { inProgress } from "../game/game";

/** How far a player can reach to identify a body, squared. */
const REACH_SQ = 120 * 120;
/** Carrying distance limits, matching the C# `PropMover` constants. */
const MIN_HOLD = 80;
const MAX_HOLD = 150;

/**
 * Height of the carry beam's origin above the pawn's feet.
 *
 * `PropMover.refreshLines` raised `AbsOrigin` by 64 and then teleported the beam to
 * `playerOrigin.Z - 16` — net feet+48, i.e. chest/hand height, NOT the eye height the hold point is
 * computed from. Starting the line at the eye makes it read as coming out of the player's face.
 */
const HAND_HEIGHT = 48;
/** Eye height used for the hold point, as `GetEyePosition` returned. */
const EYE_HEIGHT = 64;
/** Translucent white, matching `Color.FromArgb(32, Color.White)` + `kRenderTransAlpha`. */
const BEAM_COLOR: [number, number, number, number] = [255, 255, 255, 32];
const BEAM_WIDTH = 2;
/**
 * The pose a carried corpse is pinned to: lying on its side, yaw following the carrier.
 *
 * The C#'s clock-driven spin (`BODY_SPIN_RATE`) and orbit offset are gone — those are what made a
 * carried body read as a rotating signpost. Letting PHYSICS hold it instead was tried and is worse:
 * with the root snapped to the hold point every frame, the solver fights the teleport and the corpse
 * spasms. Holding it rigid is the honest option while `EntityRef` exposes no origin getter — a real
 * spring needs to read where the body actually is each frame, and nothing here can.
 */
const DEAD_PITCH = 90;
const DEAD_ROLL = 90;

/** The prop each slot is currently carrying, or null. */
const carrying: (EntityRef | null)[] = new Array<EntityRef | null>(MAX_SLOTS).fill(null);
/** The beam drawn from each carrier's hands to what they are holding, or null. */
const carryBeam: (BeamHandle | null)[] = new Array<BeamHandle | null>(MAX_SLOTS).fill(null);
/** Distance at which each slot is holding its prop. */
const holdDistance = new Float32Array(MAX_SLOTS);
/** Whether USE was down last tick, so we only act on the press edge for identification. */
const usePressed = new Uint8Array(MAX_SLOTS);

/**
 * Entity indices of this round's `prop_physics_multiplayer` props — the port of `onStartUse`'s
 * `TryGetHitEntityByDesignerName("prop_physics_multiplayer")` test.
 *
 * `EntityRef` exposes no classname, so the designer-name filter has to be turned inside out: the
 * class is resolved once, in bulk, and the trace hit is then a set membership test. Rebuilt at the
 * IN_PROGRESS transition rather than on map start because the engine's round restart re-creates
 * map-placed entities, and never per trace — `tryPickup` runs every frame a player holds USE.
 */
const physicsProps = new Set<number>();

let bus: EventBus<TttEvents>;

/** Wire the interaction layer to the bus. */
export function initInteract(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;

  bus.on(
    "gameState",
    (ev) => {
      if (ev.state === GameState.InProgress) {
        indexPhysicsProps();
        return;
      }
      // Drop everything the moment the round stops running. `tickInteract` is only driven while the
      // round is IN_PROGRESS, so nothing would otherwise call `release` again: a player still
      // holding a corpse at round end would keep its beam in the world (and the prop its frozen
      // physics) until the map changed, and the corpse itself is destroyed out from under them a
      // moment later.
      resetInteract();
    },
    { ignoreCanceled: true },
  );

  // A disconnecting carrier never reaches `release` on its own: `tickInteract` walks
  // `reg.activeSlots()`, which drops the slot the instant the client goes. That used to leak only a
  // dangling ref; with the beam and DisableMotion it strands a rendered env_beam in the world and a
  // permanently frozen prop, and — worse — leaves `carrying[slot]` live for whoever takes the slot
  // next, who would teleport the previous occupant's corpse across the map on their first USE. The
  // C# leak was keyed by controller, so it could not be inherited; a slot-indexed port must clear.
  bus.on("leave", (ev) => {
    release(ev.slot);
    usePressed[ev.slot] = 0;
    holdDistance[ev.slot] = 0;
  });
}

/** Snapshot the round's carryable physics props. See {@link physicsProps}. */
function indexPhysicsProps(): void {
  physicsProps.clear();
  const props = Entity.findByClass("prop_physics_multiplayer");
  for (let i = 0; i < props.length; i++) physicsProps.add(props[i]!.index);
}

/**
 * Advance USE interactions for every player. Driven from the plugin's one shared frame handler.
 * `dt` is elapsed seconds (used for defuse progress).
 */
export function tickInteract(dt: number): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const pawn = pawnOf(slot);
    if (pawn === null) {
      release(slot);
      continue;
    }

    const holding = (pawn.buttons & Button.Use) !== 0;
    const wasHolding = usePressed[slot] === 1;
    usePressed[slot] = holding ? 1 : 0;

    if (!holding) {
      release(slot);
      continue;
    }

    // Already carrying something: keep it in front of the player and skip the rest.
    const held = carrying[slot];
    if (held !== null) {
      if (held.isValid()) {
        carry(slot, held);
        continue;
      }
      // The carried entity died under us (round restart, `Kill` input). Go through `release` so the
      // beam is destroyed with it instead of being orphaned in the world.
      release(slot);
    }

    // Defusing takes priority — it is the only interaction with progress state.
    if (tryDefuseTripwire(slot, dt)) continue;

    // Only act on the rising edge for identification, so holding USE does not re-fire.
    if (!wasHolding) interactOnce(slot);
    else if (cfg.propPickup) tryPickup(slot);
  }
}

/** The corpse the player is looking at (or standing over), if any. */
function bodyInReach(slot: number): Body | undefined {
  const pawn = pawnOf(slot);
  if (pawn === null) return undefined;

  const hit = pawn.aimTrace({ distance: MAX_HOLD + 60, mask: TraceMask.ShotPhysics });
  let body: Body | undefined;

  if (hit !== null && hit.didHit && hit.entity !== null) {
    body = bodyByEntity(hit.entity.index);
  }
  // Fall back to proximity: a corpse whose model failed to load has nothing to trace against.
  return body ?? nearestBody(slot, REACH_SQ);
}

/** Resolve what the player is looking at and act on it once. */
function interactOnce(slot: number): void {
  // Kept here as well as in `bodyInReach`: with no pawn there is nothing to pick up either, and
  // falling through to `tryPickup` would be a behaviour change rather than a refactor.
  if (pawnOf(slot) === null) return;

  const body = bodyInReach(slot);
  if (body !== undefined) {
    identify(slot, body, true);
    return;
  }
  if (cfg.propPickup) tryPickup(slot);
}

/**
 * Identify a corpse from a weapon inspect, as a second trigger alongside USE.
 *
 * The C# reaches this through the same door: `PropMover.onButtonsChanged` runs `onStartUse` when
 * EITHER `PlayerButtons.Use` OR `PlayerButtons.Inspect` is pressed, and that trace is what feeds
 * `PropPickupEvent` -> `BodyPickupListener` -> `BodyIdentifyEvent`.
 *
 * It is driven off the `inspect_weapon` game event rather than a button bit. `PlayerButtons.Inspect`
 * is `1 << 35` (CSSharp `PlayerButtons.cs:48`) and `pawn.buttons` is a JS `number` — a `&` against
 * it truncates to 32 bits, and `1 << 35` evaluates to `8` in JS because the shift count is taken
 * mod 32. The {@link Button} enum simply cannot express this bit, so the event is the honest route.
 * The cost is that a player with no weapon deployed cannot inspect, and so cannot identify this way;
 * USE still works for them.
 *
 * NO CARRY, unlike the C#. This port's carry is hold-based (`tickInteract` releases the moment USE
 * is not held), so a carry begun by a tap would drop on the very next tick. The C# gets away with
 * sharing the path only because its release is gated on USE being released
 * (`PropMover.cs:99`), which means an inspect-started grab there sticks until the player presses and
 * releases E — a quirk, not something worth reproducing.
 */
export function inspectIdentify(slot: number): void {
  // `identify` gates on the round for the identification itself, but the DNA read above that gate
  // relies on the caller having done so — `tickInteract` is only pumped while the round is live
  // (`plugin.ts`), whereas `inspect_weapon` fires whenever a player inspects. Match the tick path.
  if (!inProgress()) return;

  const body = bodyInReach(slot);
  if (body === undefined) return;
  identify(slot, body, false);
}

/**
 * Identify a corpse. Body Paint makes the corpse *appear* identified without revealing anything,
 * and Gloves let a Traitor move a body without triggering identification at all.
 */
function identify(slot: number, body: Body, canCarry: boolean): void {
  // The DNA read is a SIBLING of identification in the C# (`DnaListener` subscribes to the same
  // `PropPickupEvent`), not a consequence of it: it fires on an already-identified body, on your own
  // body and on a body being moved with Gloves — so it goes above every gate below. (The C# also
  // read out of round; here `tickInteract` only runs while the round is live, so that case cannot
  // arise either way.) The one visible difference is chat ordering: `DnaListener` is Priority.LOW,
  // so the C# printed the scan AFTER the identification announcement, and this prints it before.
  readDna(slot, body);

  if (body.identified) return;
  if (body.owner === slot) return; // you cannot find your own corpse
  if (!inProgress()) return;

  // A Traitor wearing Gloves moves the body silently instead of identifying it.
  if (reg.roleOf(slot) === RoleId.Traitor && hasGloves(slot)) {
    // On a trigger that cannot carry (inspect), stop here rather than falling through. Spending a
    // charge would buy a carry that drops on the next tick, and letting the identification proceed
    // instead would defeat the one thing Gloves exist to prevent. Doing nothing is the only option
    // that costs the Traitor neither the charge nor the concealment.
    if (!canCarry) return;
    if (spendGlove(slot, true)) {
      beginCarry(slot, body.ref, MIN_HOLD, null);
      return;
    }
  }

  // Body Paint fakes an identification without revealing the role.
  if (reg.roleOf(slot) === RoleId.Traitor && hasBodyPaint(slot) && !body.painted) {
    if (spendBodyPaint(slot, body)) return;
  }

  const ev = bus.emit("bodyIdentify", { body, identifier: slot, canceled: false });
  if (ev.canceled) return;

  body.identified = true;
}

/**
 * Start carrying the physics prop or corpse the player is looking at.
 *
 * `onStartUse` resolved its trace hit through `TryGetHitEntityByDesignerName("prop_ragdoll")` and
 * then `("prop_physics_multiplayer")` and bailed on `hitEntity == null` — nothing else in the world
 * was ever pickable. That filter is reproduced here rather than trusting the trace: without it,
 * standing within 200u of another player with USE held DisableMotion's their pawn, strings a beam to
 * it and teleports them in front of you every frame, and the same goes for a func_ brush, a dropped
 * weapon or a hostage.
 */
function tryPickup(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null) return;
  const origin = pawn.origin;
  if (origin === null) return;

  const hit = pawn.aimTrace({ distance: 200, mask: TraceMask.ShotPhysics });
  if (hit !== null && hit.didHit && hit.entity !== null) {
    // The body tracker is the real "is this a prop_ragdoll?" test — every corpse in the mode is one
    // it spawned — and {@link physicsProps} stands in for the second designer-name lookup.
    const index = hit.entity.index;
    if (bodyByEntity(index) !== undefined || physicsProps.has(index)) {
      const dx = hit.endPos.x - origin.x;
      const dy = hit.endPos.y - origin.y;
      const dz = hit.endPos.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 200) return;
      beginCarry(slot, hit.entity, Math.min(MAX_HOLD, Math.max(MIN_HOLD, dist)), hit.endPos);
      return;
    }
  }

  // Fall back to proximity, exactly as identification does.
  //
  // A dead player's pawn is hidden (alpha 0) but KEEPS ITS COLLISION, and it sits right where the
  // corpse is. So the aim trace often stops on an invisible obstacle instead of the ragdoll behind
  // it, and this returned with no target — which reads in game as "some bodies can be picked up and
  // some cannot", varying with how the ragdoll happened to come to rest against its own pawn.
  //
  // Identification never showed the bug because it already had this fallback; pickup did not. The
  // trace cannot simply skip the pawns either: `ignoreEntity` takes a single entity, and there is
  // one hidden pawn per corpse.
  const body = nearestBody(slot, REACH_SQ);
  if (body === undefined || !body.ref.isValid()) return;
  const bx = body.x - origin.x;
  const by = body.y - origin.y;
  const bz = body.z - origin.z;
  const bodyDist = Math.sqrt(bx * bx + by * by + bz * bz);
  beginCarry(
    slot,
    body.ref,
    Math.min(MAX_HOLD, Math.max(MIN_HOLD, bodyDist)),
    new Vector(body.x, body.y, body.z),
  );
}

/**
 * Take hold of `prop`: freeze its physics and draw the hand-to-object beam.
 *
 * `end` seeds the beam's far endpoint where the caller already knows it (a trace hit); the Gloves
 * path has no trace, so the beam starts degenerate and {@link carry} moves it on the next frame.
 */
function beginCarry(slot: number, prop: EntityRef, distance: number, end: Vector | null): void {
  carrying[slot] = prop;
  holdDistance[slot] = distance;

  // `onStartUse` fired this on every pickup. A carried object is teleported every frame, so leaving
  // its physics live means gravity and collisions fight the teleport: the prop jitters and sinks
  // instead of floating. Handed back in `release`.
  prop.acceptInput("DisableMotion");

  const origin = pawnOf(slot)?.origin ?? null;
  if (origin === null) return;
  const start = new Vector(origin.x, origin.y, origin.z + HAND_HEIGHT);
  // Created once per pickup, never per frame: `createBeam`'s C# counterpart carried a comment that
  // env_beam removal is unreliable, so a recreate-per-tick beam leaks one entity every tick.
  carryBeam[slot] = Beam.draw(start, end ?? start, { color: BEAM_COLOR, width: BEAM_WIDTH });
}

/** Keep a carried prop floating in front of the player's view, and keep its beam attached. */
function carry(slot: number, prop: EntityRef): void {
  const pawn = pawnOf(slot);
  if (pawn === null) {
    release(slot);
    return;
  }
  const origin = pawn.origin;
  const angles = pawn.eyeAngles;
  if (origin === null || angles === null) {
    release(slot);
    return;
  }

  const forward = forwardVector(angles);
  const eye = new Vector(origin.x, origin.y, origin.z + EYE_HEIGHT);
  let distance = holdDistance[slot]!;

  // Do not push the prop through a wall.
  const clear = Trace.line(
    eye,
    new Vector(
      eye.x + forward.x * distance,
      eye.y + forward.y * distance,
      eye.z + forward.z * distance,
    ),
    { mask: TraceMask.WorldOnly, ignoreEntity: prop },
  );
  if (clear.didHit) distance = Math.max(MIN_HOLD * 0.5, distance * clear.fraction - 8);

  let x = eye.x + forward.x * distance;
  let y = eye.y + forward.y * distance;
  const z = eye.z + forward.z * distance;

  // A CORPSE HANGS FROM ITS MIDDLE AND IS LEFT TO SWING; a prop keeps the plain rigid carry.
  //
  // Two things were wrong with the body case. A ragdoll's origin sits at its FEET, so putting the
  // origin on the hold point hung the body by its ankles — the beam terminated there and the corpse
  // dangled upside-down beneath it. Dropping the target by a torso height puts the hold point through
  // the chest instead.
  //
  // The rest was a forced pose: the body was spun on a clock (`BODY_SPIN_RATE`), pushed around an
  // orbit, pinned to fixed angles, and had its velocity ZEROED every frame. That is four separate
  // ways of telling the physics solver what to do, and together they made a corpse behave like a
  // rotating signpost. Passing null for both angles and velocity moves the root and leaves everything
  // else to physics, so the limbs trail and the body settles as it is dragged.
  const carriedBody = bodyByEntity(prop.index);
  const isBody = carriedBody !== undefined;

  // Pull the ROOT back along the body's length so its middle lands on the hold point.
  //
  // That length runs along the carrier's RIGHT vector, measured in game rather than derived: with
  // `pitch 90` AND `roll 90` the model's feet-to-head axis ends up perpendicular to the view, so the
  // corpse extends off to one side. Offsetting on Z (upright-body thinking) and then along FORWARD
  // were both wrong for the same reason — the axis was assumed from the angle convention instead of
  // observed. Right = (sin yaw, -cos yaw) for Source's counter-clockwise yaw.
  const yawRad = angles.y * (Math.PI / 180);
  const rightX = Math.sin(yawRad);
  const rightY = -Math.cos(yawRad);
  const half = n("sm_ttt_carry_body_offset");
  const putX = isBody ? x - rightX * half : x;
  const putY = isBody ? y - rightY * half : y;
  const putZ = z;
  const holdZ = z;

  // Held rigid, and the yaw simply follows the carrier so the body swings round with them instead of
  // spinning on its own clock. Velocity is zeroed for the same reason the angles are pinned: anything
  // the solver is allowed to do here turns into a spasm, because the root is being snapped rather
  // than pulled.
  const deadAngles = isBody ? [DEAD_PITCH, angles.y, DEAD_ROLL] : [0, 0, 0];
  prop.teleport([putX, putY, putZ], deadAngles, [0, 0, 0]);

  // Keep the body's cached position in step with where it actually is.
  //
  // Identification aim-traces with a BULLET mask, and a corpse is COLLISION_GROUP_DEBRIS — "collides
  // with nothing but world" — so the trace deliberately passes straight through it. That is the same
  // property that stops corpses eating shots, and it cannot be had both ways. What catches the body
  // is the proximity fallback, which compares against these coordinates; leaving them at the death
  // position meant a body you had DRAGGED could only be identified by standing where its owner died.
  //
  // (The C# never needed this: it identified through the engine's own PropPickupEvent rather than a
  // trace, so collision group never entered into it.)
  if (carriedBody !== undefined) {
    // Cache the CENTRE, which is what a player aims at to identify it, not the feet.
    carriedBody.x = x;
    carriedBody.y = y;
    carriedBody.z = holdZ;
  }

  const beam = carryBeam[slot];
  if (beam !== null) {
    // The far end tracks where the object was just put, not the pre-orbit hold point — an
    // `EntityRef` exposes no origin to read it back from, and this is the same position one frame
    // earlier than the C#'s `AbsOrigin` read.
    // The far end is the HOLD point (centre mass), not where the root was placed — otherwise the
    // beam visibly ends at the corpse's ankles.
    beam.update(new Vector(origin.x, origin.y, origin.z + HAND_HEIGHT), new Vector(x, y, holdZ));
  }
}

/**
 * Drop whatever this player is carrying.
 *
 * Called every frame for every player who is not holding USE, so it must be cheap and idempotent —
 * firing `EnableMotion` or removing a beam unconditionally would spam an entity input per player
 * per frame. Both paths bail on the null handles first.
 */
export function release(slot: number): void {
  const beam = carryBeam[slot];
  if (beam !== null) {
    beam.remove();
    carryBeam[slot] = null;
  }

  const held = carrying[slot];
  if (held === null) return;
  carrying[slot] = null;
  if (!held.isValid()) return;

  // Only hand physics back once nobody else still has hold of the same object, as `onCeaseUse` did.
  // Compared by entity index: each pickup stores its own `EntityRef` instance, so two players
  // holding one corpse have two distinct refs.
  for (let i = 0; i < MAX_SLOTS; i++) if (carrying[i]?.index === held.index) return;
  held.acceptInput("EnableMotion");

  // Zero the velocity one frame after motion comes back, or the corpse launches across the map.
  //
  // A carried object is teleported to a point in front of the player every frame with motion
  // DISABLED. The physics engine still derives a velocity from that displacement, and it is a
  // per-frame teleport delta — huge. `EnableMotion` then hands the body back to physics carrying
  // all of it at once. The zeroing has to be deferred: `acceptInput` queues on the engine's I/O
  // pump rather than running inline, so a teleport issued here would be overwritten when
  // EnableMotion actually lands.
  const dropped = held;
  void nextFrame().then(() => {
    if (dropped.isValid()) dropped.teleport(null, null, [0, 0, 0]);
  });
}

/** Drop everything (round boundary / map change). */
export function resetInteract(): void {
  // Through `release` so beams are destroyed and physics handed back; clearing the arrays outright
  // leaks one env_beam per carrier per round and leaves the prop frozen where it was dropped.
  for (let slot = 0; slot < MAX_SLOTS; slot++) release(slot);
  usePressed.fill(0);
  holdDistance.fill(0);
  // Entity indices are recycled, so a snapshot must not outlive the round it was taken in — it is
  // rebuilt at the next IN_PROGRESS transition, which is the only state `tryPickup` reads it from.
  physicsProps.clear();
}
