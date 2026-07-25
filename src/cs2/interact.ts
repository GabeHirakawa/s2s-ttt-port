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
import type { EntityRef } from "@s2script/sdk/entity";
import { Button, MAX_SLOTS, RoleId } from "../core/enums";
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

/** The prop each slot is currently carrying, or null. */
const carrying: (EntityRef | null)[] = new Array<EntityRef | null>(MAX_SLOTS).fill(null);
/** Distance at which each slot is holding its prop. */
const holdDistance = new Float32Array(MAX_SLOTS);
/** Whether USE was down last tick, so we only act on the press edge for identification. */
const usePressed = new Uint8Array(MAX_SLOTS);

let bus: EventBus<TttEvents>;

/** Wire the interaction layer to the bus. */
export function initInteract(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;
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
      carrying[slot] = null;
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
      carrying[slot] = body.ref;
      holdDistance[slot] = MIN_HOLD;
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

  carrying[slot] = hit.entity;
  holdDistance[slot] = Math.min(MAX_HOLD, Math.max(MIN_HOLD, dist));
}

/** Keep a carried prop floating in front of the player's view. */
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
  const eye = new Vector(origin.x, origin.y, origin.z + 64);
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

  prop.teleport(
    [eye.x + forward.x * distance, eye.y + forward.y * distance, eye.z + forward.z * distance],
    null,
    [0, 0, 0],
  );
}

/** Drop whatever this player is carrying. */
export function release(slot: number): void {
  carrying[slot] = null;
}

/** Drop everything (round boundary / map change). */
export function resetInteract(): void {
  carrying.fill(null);
  usePressed.fill(0);
  holdDistance.fill(0);
}
