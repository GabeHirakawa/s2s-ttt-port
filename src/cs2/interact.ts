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

import { Trace, TraceMask } from "@s2script/sdk/trace";
import { Vector, forwardVector } from "@s2script/sdk/math";
import { Server } from "@s2script/sdk/server";
import type { EntityRef } from "@s2script/sdk/entity";
import { Beam, type BeamHandle } from "@s2script/cs2";
import { Button, GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { cfg } from "../core/cvars";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf } from "./pawn";
import { bodyByEntity, nearestBody, type Body } from "./bodies";
import { hasBodyPaint, spendBodyPaint, spendGlove, hasGloves, tryDefuseTripwire } from "../shop/effects";
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
/** Corpse spin, from `PropMover.moveBody`: degrees per second, orbit radius, perpendicular bias. */
const BODY_SPIN_RATE = 64;
const BODY_ORBIT = 32;
const BODY_BIAS = 16;
/** `DEAD_ANGLE` — the pitch/roll a carried ragdoll is held at; the yaw is spun. */
const DEAD_PITCH = 90;
const DEAD_YAW = 45;
const DEAD_ROLL = 90;

/** The prop each slot is currently carrying, or null. */
const carrying: (EntityRef | null)[] = new Array<EntityRef | null>(MAX_SLOTS).fill(null);
/** The beam drawn from each carrier's hands to what they are holding, or null. */
const carryBeam: (BeamHandle | null)[] = new Array<BeamHandle | null>(MAX_SLOTS).fill(null);
/** Distance at which each slot is holding its prop. */
const holdDistance = new Float32Array(MAX_SLOTS);
/** Whether USE was down last tick, so we only act on the press edge for identification. */
const usePressed = new Uint8Array(MAX_SLOTS);

let bus: EventBus<TttEvents>;

/** Wire the interaction layer to the bus. */
export function initInteract(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;

  // Drop everything the moment the round stops running. `tickInteract` is only driven while the
  // round is IN_PROGRESS, so nothing would otherwise call `release` again: a player still holding a
  // corpse at round end would keep its beam in the world (and the prop its frozen physics) until
  // the map changed, and the corpse itself is destroyed out from under them a moment later.
  bus.on(
    "gameState",
    (ev) => {
      if (ev.state !== GameState.InProgress) resetInteract();
    },
    { ignoreCanceled: true },
  );
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

/** Resolve what the player is looking at and act on it once. */
function interactOnce(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null) return;

  const hit = pawn.aimTrace({ distance: MAX_HOLD + 60, mask: TraceMask.ShotPhysics });
  let body: Body | undefined;

  if (hit !== null && hit.didHit && hit.entity !== null) {
    body = bodyByEntity(hit.entity.index);
  }
  // Fall back to proximity: a corpse whose model failed to load has nothing to trace against.
  body ??= nearestBody(slot, REACH_SQ);

  if (body !== undefined) {
    identify(slot, body);
    return;
  }
  if (cfg.propPickup) tryPickup(slot);
}

/**
 * Identify a corpse. Body Paint makes the corpse *appear* identified without revealing anything,
 * and Gloves let a Traitor move a body without triggering identification at all.
 */
function identify(slot: number, body: Body): void {
  if (body.identified) return;
  if (body.owner === slot) return; // you cannot find your own corpse
  if (!inProgress()) return;

  // A Traitor wearing Gloves moves the body silently instead of identifying it.
  if (reg.roleOf(slot) === RoleId.Traitor && hasGloves(slot)) {
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

/** Start carrying whatever physics prop the player is looking at. */
function tryPickup(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null) return;
  const hit = pawn.aimTrace({ distance: 200, mask: TraceMask.ShotPhysics });
  if (hit === null || !hit.didHit || hit.entity === null) return;

  const origin = pawn.origin;
  if (origin === null) return;
  const dx = hit.endPos.x - origin.x;
  const dy = hit.endPos.y - origin.y;
  const dz = hit.endPos.z - origin.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > 200) return;

  beginCarry(slot, hit.entity, Math.min(MAX_HOLD, Math.max(MIN_HOLD, dist)), hit.endPos);
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

  // A corpse is dragged, not held: `moveBody` orbits the hold point and spins the ragdoll so it
  // reads as a body being hauled along. Props keep the plain zero-angle teleport, which is what the
  // C# `prop_physics_multiplayer` branch did.
  let deadAngles: number[] | null = null;
  if (bodyByEntity(prop.index) !== undefined) {
    const rotDeg = (Server.gameTime * BODY_SPIN_RATE) % 360;
    const rad = rotDeg * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Bias along the perpendicular (cos/sin of rad + 90°), then step back along the orbit radius —
    // this is `endPos += bias; endPos -= off` from the original, folded into one add.
    x += -sin * BODY_BIAS - cos * BODY_ORBIT;
    y += cos * BODY_BIAS - sin * BODY_ORBIT;
    deadAngles = [DEAD_PITCH, DEAD_YAW + rotDeg, DEAD_ROLL];
  }

  prop.teleport([x, y, z], deadAngles, [0, 0, 0]);

  const beam = carryBeam[slot];
  if (beam !== null) {
    // The far end tracks where the object was just put, not the pre-orbit hold point — an
    // `EntityRef` exposes no origin to read it back from, and this is the same position one frame
    // earlier than the C#'s `AbsOrigin` read.
    beam.update(new Vector(origin.x, origin.y, origin.z + HAND_HEIGHT), new Vector(x, y, z));
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
}

/** Drop everything (round boundary / map change). */
export function resetInteract(): void {
  // Through `release` so beams are destroyed and physics handed back; clearing the arrays outright
  // leaks one env_beam per carrier per round and leaves the prop frozen where it was dropped.
  for (let slot = 0; slot < MAX_SLOTS; slot++) release(slot);
  usePressed.fill(0);
  holdDistance.fill(0);
}
