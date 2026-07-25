/**
 * Shop item behaviour — the port of the per-item listeners under `TTT/CS2/Items` and
 * `TTT/Shop/Items` (`PoisonShotsListener`, `GlovesListener`, `StickerListener`,
 * `OneShotDeagleDamageListener`, `TripwireMovementListener`, `HealthStation`, `DamageStation`,
 * `DnaListener`, `BodyPaintListener`, `ClusterGrenadeListener`, `AbstractCompassItem`, …).
 *
 * Every per-player item flag is a slot-indexed typed array, and every listener is a single
 * subscription on the TTT bus rather than a separate DI-registered class hooking its own game
 * events. The C# spread this across ~40 files, each resolving services from the container and
 * re-reading its config record on each property access.
 *
 * Placed world objects (stations, tripwires, C4) live in small arrays scanned from the plugin's one
 * shared tick — the originals each ran their own repeating timer.
 */

import { createEntity, type EntityRef } from "@s2script/sdk/entity";
import { Vector } from "@s2script/sdk/math";
import { Trace, TraceMask } from "@s2script/sdk/trace";
import { Beam, HintText, type BeamHandle } from "@s2script/cs2";
import { Server } from "@s2script/sdk/server";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { b, n, s } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setHealth, tell } from "../cs2/pawn";
import { setPawnAlpha } from "../cs2/color";
import { KNIVES } from "../cs2/inventory";
import { allBodies, type Body } from "../cs2/bodies";
import { addBalance } from "./shop";
import { resetWeaponFx } from "./weaponfx";
import { game, inProgress } from "../game/game";
import { roleName } from "../game/roles";

/** Which target set a compass points at. */
export const enum CompassMode {
  Off = 0,
  Players = 1,
  Bodies = 2,
}

// ── per-player item state ────────────────────────────────────────────────────
/** Owns a Taser (its damage is converted into a role scan). */
const hasTaser = new Uint8Array(MAX_SLOTS);
/** Owns Stickers: tasing someone reveals their role to everyone. */
const hasStickers = new Uint8Array(MAX_SLOTS);
/** Owns a DNA Scanner. */
const hasDna = new Uint8Array(MAX_SLOTS);
/** Owns the One-Shot Revolver. */
const hasRevolver = new Uint8Array(MAX_SLOTS);
/** Owns the One-Hit Knife (consumed on the next knife hit). */
const hasOneHitKnife = new Uint8Array(MAX_SLOTS);
/** Is camouflaged. */
const camouflaged = new Uint8Array(MAX_SLOTS);
/** Remaining Glove uses. */
const gloveUses = new Int32Array(MAX_SLOTS);
/** Remaining Body Paint uses. */
const paintUses = new Int32Array(MAX_SLOTS);
/** Remaining poisoned shots. */
const poisonShots = new Int32Array(MAX_SLOTS);
/** Active compass mode. */
const compass = new Uint8Array(MAX_SLOTS);

// ── poison applied to victims ────────────────────────────────────────────────
/** Poison damage still owed to each slot. */
const poisonRemaining = new Int32Array(MAX_SLOTS);
/** Seconds until the next poison tick. */
const poisonTimer = new Float32Array(MAX_SLOTS);

/** A placed health/hurt station. */
interface Station {
  /** The visible prop, or null when no model could be spawned (the station still works). */
  ref: EntityRef | null;
  owner: number;
  /** Health delta applied per tick — negative for a hurt station. */
  increment: number;
  /** Remaining budget (0 = unlimited). */
  budget: number;
  x: number;
  y: number;
  z: number;
  timer: number;
}

/** A placed tripwire. */
interface Tripwire {
  owner: number;
  beam: BeamHandle | null;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Seconds until it arms. */
  arming: number;
  /** Accumulated defuse progress in seconds, and who is defusing. */
  defuseProgress: number;
  defuser: number;
  alive: boolean;
}

/** Decoration model for a station. Precached at map start; a miss degrades to an invisible station. */
const STATION_MODEL = "models/props/cs_office/microwave.vmdl";

const stations: Station[] = [];
const tripwires: Tripwire[] = [];
let activeC4 = 0;

// ── grant hooks called by the item definitions ───────────────────────────────
/** Grant the Taser scan behaviour. */
export function grantTaser(slot: number): void { hasTaser[slot] = 1; }
/** Grant Stickers. */
export function grantStickers(slot: number): void { hasStickers[slot] = 1; }
/** Grant the DNA Scanner. */
export function grantDnaScanner(slot: number): void { hasDna[slot] = 1; }
/** Grant the One-Shot Revolver. */
export function grantOneShotRevolver(slot: number): void { hasRevolver[slot] = 1; }
/** Grant the One-Hit Knife. */
export function grantOneHitKnife(slot: number): void { hasOneHitKnife[slot] = 1; }
/** Note that a C4 charge is now out in the world. */
export function grantC4(): void { activeC4++; }
/** Note that a C4 charge went off or was defused. */
export function releaseC4(): void { if (activeC4 > 0) activeC4--; }
/** How many C4 charges are unaccounted for — the per-round "max at once" gate reads this. */
export function c4Count(): number { return activeC4; }
/** Grant Camouflage. */
export function grantCamo(slot: number): void { camouflaged[slot] = 1; applyCamo(slot); }
/** Grant Gloves with `uses` charges. */
export function grantGloves(slot: number, uses: number): void { gloveUses[slot] = uses; }
/** Grant Body Paint with `uses` charges. */
export function grantBodyPaint(slot: number, uses: number): void { paintUses[slot] = uses; }
/** Grant `count` poisoned shots. */
export function grantPoisonShots(slot: number, count: number): void { poisonShots[slot] = count; }
/** Turn on a compass. */
export function grantCompass(slot: number, mode: CompassMode): void { compass[slot] = mode; }
/** Does this player have Gloves charges left? */
export function hasGloves(slot: number): boolean { return gloveUses[slot]! > 0; }
/** Does this player have Body Paint charges left? */
export function hasBodyPaint(slot: number): boolean { return paintUses[slot]! > 0; }
/** Does this player own a DNA scanner? */
export function ownsDnaScanner(slot: number): boolean { return hasDna[slot] === 1; }

/**
 * Spend one Glove charge. Returns true if a charge was available. Called when a Traitor kills
 * someone or moves a body — it suppresses the DNA trace either way.
 */
export function spendGlove(slot: number, forBody: boolean): boolean {
  const left = gloveUses[slot]!;
  if (left <= 0) return false;
  gloveUses[slot] = left - 1;
  const max = n("css_ttt_shop_gloves_max_uses");
  tell(
    slot,
    forBody
      ? msg("SHOP_ITEM_GLOVES_USED_BODY", left - 1, max)
      : msg("SHOP_ITEM_GLOVES_USED_KILL", left - 1, max),
  );
  if (left - 1 === 0) tell(slot, msg("SHOP_ITEM_GLOVES_WORN_OUT"));
  return true;
}

/** Spend one Body Paint charge on `body`, making it look identified without revealing anything. */
export function spendBodyPaint(slot: number, body: Body): boolean {
  const left = paintUses[slot]!;
  if (left <= 0) return false;
  paintUses[slot] = left - 1;
  body.painted = true;
  if (left - 1 === 0) tell(slot, msg("SHOP_ITEM_BODY_PAINT_OUT"));
  return true;
}

/**
 * Apply camouflage: drop the pawn's opacity to the configured visibility.
 *
 * `m_clrRender` is not in the s2script schema, so this goes through the pawn's `Alpha` entity input
 * (see `cs2/color.ts`). `css_ttt_shop_camo_visibility` is a 0..1 multiplier, matching the C# config.
 */
function applyCamo(slot: number): void {
  const visibility = n("css_ttt_shop_camo_visibility");
  setPawnAlpha(slot, Math.round(Math.max(0, Math.min(1, visibility)) * 255));
}

/** Is this player camouflaged (used by the name-display system)? */
export function isCamouflaged(slot: number): boolean {
  return camouflaged[slot] === 1;
}

// ── stations ─────────────────────────────────────────────────────────────────
/**
 * Place a station in front of `slot`. `increment` is the per-tick health delta (negative for the
 * Traitor hurt station).
 *
 * The visible prop is best-effort: a station is fundamentally a position plus a radius, so if the
 * decoration model will not spawn on this map the station is still placed and still works. The C#
 * version aborted the whole purchase if the entity failed.
 */
export function placeStation(slot: number, increment: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null) return;
  const hit = pawn.aimTrace({ distance: 128, mask: TraceMask.WorldOnly });
  const at = hit?.endPos ?? pawn.origin;
  if (at === null || at === undefined) return;

  const ent = createEntity("prop_physics_override", {
    model: STATION_MODEL,
    targetname: `ttt_station_${slot}`,
    health: n("css_ttt_shop_healthstation_station_health"),
  });
  ent?.teleport([at.x, at.y, at.z + 8], null, [0, 0, 0]);

  stations.push({
    ref: ent,
    owner: slot,
    increment,
    budget: Math.abs(n("css_ttt_shop_healthstation_total_health_given")),
    x: at.x,
    y: at.y,
    z: at.z,
    timer: 0,
  });
}

/** Apply station effects. `dt` is elapsed seconds. */
function tickStations(dt: number): void {
  if (stations.length === 0) return;
  const interval = Math.max(0.1, n("css_ttt_shop_healthstation_interval"));
  const range = n("css_ttt_shop_healthstation_max_range");
  const rangeSq = range * range;

  for (let i = stations.length - 1; i >= 0; i--) {
    const st = stations[i]!;
    // A station whose prop was destroyed is gone; one that never had a prop keeps working.
    if (st.ref !== null && !st.ref.isValid()) {
      stations.splice(i, 1);
      continue;
    }
    st.timer += dt;
    if (st.timer < interval) continue;
    st.timer = 0;

    const heals = st.increment > 0;
    const active = reg.activeSlots();
    for (let j = 0; j < active.length; j++) {
      const slot = active[j]!;
      if (!reg.isAlive(slot)) continue;
      // A hurt station spares its owner's own team, matching the C# `DamageStation`.
      if (!heals && reg.roleOf(slot) === RoleId.Traitor) continue;

      const pawn = pawnOf(slot);
      if (pawn === null) continue;
      const o = pawn.origin;
      if (o === null) continue;
      const dx = o.x - st.x;
      const dy = o.y - st.y;
      const dz = o.z - st.z;
      if (dx * dx + dy * dy + dz * dz > rangeSq) continue;

      const hp = pawn.health ?? 0;
      if (heals && hp >= (pawn.maxHealth ?? 100)) continue;
      setHealth(slot, hp + st.increment);
      if (st.budget > 0) {
        st.budget -= Math.abs(st.increment);
        if (st.budget <= 0) {
          st.ref?.remove();
          stations.splice(i, 1);
          break;
        }
      }
    }
  }
}

// ── tripwires ────────────────────────────────────────────────────────────────
/**
 * Place a tripwire from where `slot` is aiming to the opposite wall. Returns false when the target
 * surface is out of range (the C# `SHOP_ITEM_TRIPWIRE_TOOFAR` case).
 */
export function placeTripwire(slot: number): boolean {
  const pawn = pawnOf(slot);
  if (pawn === null) return false;
  const first = pawn.aimTrace({ distance: 4096, mask: TraceMask.WorldOnly });
  if (first === null || !first.didHit) return false;

  const o = pawn.origin;
  if (o === null) return false;
  const dx = first.endPos.x - o.x;
  const dy = first.endPos.y - o.y;
  const dz = first.endPos.z - o.z;
  if (dx * dx + dy * dy + dz * dz > n("css_ttt_shop_tripwire_max_distance_squared")) return false;

  // Continue past the first surface to find the wall opposite, giving the wire its span.
  const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const start = new Vector(first.endPos.x, first.endPos.y, first.endPos.z);
  const far = Trace.line(
    start,
    new Vector(
      start.x + (dx / dirLen) * 512,
      start.y + (dy / dirLen) * 512,
      start.z + (dz / dirLen) * 512,
    ),
    { mask: TraceMask.WorldOnly },
  );
  const end = far.didHit ? far.endPos : new Vector(start.x, start.y, start.z + 64);

  const color: [number, number, number, number] = [
    n("css_ttt_shop_tripwire_color_r"),
    n("css_ttt_shop_tripwire_color_g"),
    n("css_ttt_shop_tripwire_color_b"),
    n("css_ttt_shop_tripwire_color_a"),
  ];
  const beam = Beam.draw(start, end, { color, width: n("css_ttt_shop_tripwire_thickness") });

  tripwires.push({
    owner: slot,
    beam,
    ax: start.x, ay: start.y, az: start.z,
    bx: end.x, by: end.y, bz: end.z,
    arming: n("css_ttt_shop_tripwire_initiation_time"),
    defuseProgress: 0,
    defuser: -1,
    alive: true,
  });
  return true;
}

/** Squared distance from a point to the segment a→b. */
function distToSegmentSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const wx = px - ax, wy = py - ay, wz = pz - az;
  const vv = vx * vx + vy * vy + vz * vz;
  let t = vv === 0 ? 0 : (wx * vx + wy * vy + wz * vz) / vv;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + vx * t - px;
  const cy = ay + vy * t - py;
  const cz = az + vz * t - pz;
  return cx * cx + cy * cy + cz * cz;
}

/** Advance tripwire arming, crossing detection and defusing. */
function tickTripwires(dt: number): void {
  if (tripwires.length === 0) return;
  const sizeSq = n("css_ttt_shop_tripwire_size_squared");
  const ffTriggers = b("css_ttt_shop_tripwire_friendlyfire_triggers");

  for (let i = tripwires.length - 1; i >= 0; i--) {
    const tw = tripwires[i]!;
    if (!tw.alive) {
      tw.beam?.remove();
      tripwires.splice(i, 1);
      continue;
    }
    if (tw.arming > 0) {
      tw.arming -= dt;
      continue;
    }

    const active = reg.activeSlots();
    for (let j = 0; j < active.length; j++) {
      const slot = active[j]!;
      if (!reg.isAlive(slot)) continue;
      const pawn = pawnOf(slot);
      if (pawn === null) continue;
      const o = pawn.origin;
      if (o === null) continue;

      // Sample at torso height so a wire at knee level still catches a standing player.
      const d = distToSegmentSq(o.x, o.y, o.z + 36, tw.ax, tw.ay, tw.az, tw.bx, tw.by, tw.bz);
      if (d > sizeSq) continue;

      const sameTeam = reg.roleOf(slot) === RoleId.Traitor;
      if (sameTeam && !ffTriggers) continue;

      detonateTripwire(tw, slot);
      tw.alive = false;
      break;
    }
  }
}

/** Blow a tripwire, damaging everyone within its falloff radius. */
function detonateTripwire(tw: Tripwire, trigger: number): void {
  const power = n("css_ttt_shop_tripwire_explosion_power");
  const falloff = n("css_ttt_shop_tripwire_falloff_delay");
  const ffMult = n("css_ttt_shop_tripwire_friendlyfire_multiplier");
  const cx = (tw.ax + tw.bx) / 2;
  const cy = (tw.ay + tw.by) / 2;
  const cz = (tw.az + tw.bz) / 2;

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    const dx = o.x - cx, dy = o.y - cy, dz = o.z - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let damage = power / (1 + dist * falloff);
    if (damage < 1) continue;
    if (reg.roleOf(slot) === RoleId.Traitor && slot !== trigger) damage *= ffMult;
    setHealth(slot, (pawn.health ?? 0) - Math.round(damage));
  }
  void tw.owner;
}

/**
 * Progress a defuse for `slot` if they are looking at a live tripwire within reach. Called from the
 * USE-key handler.
 */
export function tryDefuseTripwire(slot: number, dt: number): boolean {
  if (tripwires.length === 0) return false;
  const pawn = pawnOf(slot);
  if (pawn === null) return false;
  const o = pawn.origin;
  if (o === null) return false;

  for (let i = 0; i < tripwires.length; i++) {
    const tw = tripwires[i]!;
    if (!tw.alive) continue;
    const d = distToSegmentSq(o.x, o.y, o.z + 36, tw.ax, tw.ay, tw.az, tw.bx, tw.by, tw.bz);
    if (d > 6400) continue; // 80 units reach

    tw.defuser = slot;
    tw.defuseProgress += dt;
    const total = n("css_ttt_shop_tripwire_defuse_time");
    if (tw.defuseProgress >= total) {
      tw.alive = false;
      addBalance(slot, n("css_ttt_shop_tripwire_defuse_reward"), "Defused Tripwire");
      return true;
    }
    HintText.to(
      slot,
      msg("SHOP_ITEM_TRIPWIRE_DEFUSING", reg.nameOf(slot), Math.ceil(total - tw.defuseProgress)),
    );
    return true;
  }
  return false;
}

// ── poison ───────────────────────────────────────────────────────────────────
/**
 * Apply poison to `victim`.
 *
 * NOTE: poison damage is applied by writing health, which the engine attributes to nobody — so a
 * poison kill is not credited to the Traitor who threw the smoke. The C# had the same limitation
 * (it also drove the damage through a direct health write).
 */
export function applyPoison(victim: number): void {
  poisonRemaining[victim] = n("css_ttt_shop_poisonsmoke_poison_total_damage");
  poisonTimer[victim] = 0;
}

/** Tick poison damage. */
function tickPoison(dt: number): void {
  const interval = Math.max(0.05, n("css_ttt_shop_poisonsmoke_poison_tick_interval") / 1000);
  const perTick = n("css_ttt_shop_poisonsmoke_poison_damage_per_tick");

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (poisonRemaining[slot]! <= 0) continue;
    if (!reg.isAlive(slot)) {
      poisonRemaining[slot] = 0;
      continue;
    }
    poisonTimer[slot] = poisonTimer[slot]! + dt;
    if (poisonTimer[slot]! < interval) continue;
    poisonTimer[slot] = 0;

    const damage = Math.min(perTick, poisonRemaining[slot]!);
    poisonRemaining[slot] = poisonRemaining[slot]! - damage;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    setHealth(slot, (pawn.health ?? 0) - damage);
  }
}

// ── compass ──────────────────────────────────────────────────────────────────
let compassAccum = 0;

/** Render a text compass strip for anyone holding one. */
function tickCompass(dt: number): void {
  compassAccum += dt;
  if (compassAccum < 0.25) return;
  compassAccum = 0;

  const length = n("css_ttt_shop_compass_length");
  const fov = n("css_ttt_shop_compass_fov");
  const range = n("css_ttt_shop_compass_max_range");
  const rangeSq = range * range;

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const mode = compass[slot]! as CompassMode;
    if (mode === CompassMode.Off || !reg.isAlive(slot)) continue;

    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    const ang = pawn.eyeAngles;
    if (o === null || ang === null) continue;

    const strip: string[] = new Array<string>(length).fill("-");
    if (mode === CompassMode.Players) {
      for (let j = 0; j < active.length; j++) {
        const other = active[j]!;
        if (other === slot || !reg.isAlive(other)) continue;
        mark(strip, o.x, o.y, ang.y, fov, rangeSq, targetX(other), targetY(other), "|");
      }
    } else {
      const bodies = allBodies();
      for (let j = 0; j < bodies.length; j++) {
        const body = bodies[j]!;
        mark(strip, o.x, o.y, ang.y, fov, rangeSq, body.x, body.y, "X");
      }
    }
    HintText.to(slot, strip.join(""));
  }
}

function targetX(slot: number): number {
  return pawnOf(slot)?.origin?.x ?? Number.NaN;
}
function targetY(slot: number): number {
  return pawnOf(slot)?.origin?.y ?? Number.NaN;
}

/** Place a marker on the compass strip for a target at (tx, ty). */
function mark(
  strip: string[],
  ox: number, oy: number, yaw: number,
  fov: number, rangeSq: number,
  tx: number, ty: number,
  glyph: string,
): void {
  if (!Number.isFinite(tx)) return;
  const dx = tx - ox;
  const dy = ty - oy;
  if (dx * dx + dy * dy > rangeSq) return;

  let bearing = (Math.atan2(dy, dx) * 180) / Math.PI - yaw;
  while (bearing > 180) bearing -= 360;
  while (bearing < -180) bearing += 360;
  if (Math.abs(bearing) > fov / 2) return;

  const pos = Math.round(((bearing + fov / 2) / fov) * (strip.length - 1));
  if (pos >= 0 && pos < strip.length) strip[pos] = glyph;
}

// ── the shared tick ──────────────────────────────────────────────────────────
/** Advance every timed item effect. Driven by the plugin's single frame handler. */
export function tickEffects(dt: number): void {
  if (game.state !== GameState.InProgress) return;
  tickStations(dt);
  tickTripwires(dt);
  tickPoison(dt);
  tickCompass(dt);
}

/** Clear every per-round item flag and remove placed objects. */
export function resetEffects(): void {
  hasTaser.fill(0);
  hasStickers.fill(0);
  hasDna.fill(0);
  hasRevolver.fill(0);
  hasOneHitKnife.fill(0);
  camouflaged.fill(0);
  gloveUses.fill(0);
  paintUses.fill(0);
  poisonShots.fill(0);
  compass.fill(0);
  poisonRemaining.fill(0);
  poisonTimer.fill(0);
  activeC4 = 0;

  for (let i = 0; i < stations.length; i++) stations[i]!.ref?.remove();
  stations.length = 0;
  for (let i = 0; i < tripwires.length; i++) tripwires[i]!.beam?.remove();
  tripwires.length = 0;
}

/** Register the damage-driven item behaviours. */
export function installEffects(eventBus: EventBus<TttEvents>): void {
  eventBus.on(
    "damage",
    (ev) => {
      if (!inProgress() || ev.attacker < 0 || ev.canceled) return;
      const attacker = ev.attacker;
      const victim = ev.slot;

      // Taser: no damage, reveals the victim's role to the shooter (and everyone, with Stickers).
      //
      // The cancel must survive the `player_hurt` fallback path, where the hit has ALREADY landed:
      // if it took the victim below zero they are dead before anything can refund it, and the
      // "scan" would have killed the person it is meant to identify. Force them back to a safe
      // floor as well as cancelling, so a tase is never lethal.
      if (ev.weapon === "weapon_taser" && hasTaser[attacker] === 1) {
        ev.canceled = true;
        const pawn = pawnOf(victim);
        const hp = pawn?.health ?? 0;
        if (hp <= 0) setHealth(victim, 1);
        const role = roleName(reg.roleOf(victim));
        tell(attacker, msg("TASER_SCANNED", reg.nameOf(victim), role));
        if (hasStickers[attacker] === 1) {
          tell(victim, msg("SHOP_ITEM_STICKERS_HIT"));
          revealRole(victim);
        }
        return;
      }

      // One-Shot Revolver: an instant kill, or suicide on a teammate.
      //
      // CS2 reports the weapon as `weapon_deagle` even when the player is holding a revolver — the
      // C# carried an explicit alias for exactly this, and it matters more here because the live
      // path is `player_hurt`, whose weapon string comes straight from the engine field.
      if (hasRevolver[attacker] === 1 && isOneShotWeapon(ev.weapon)) {
        const sameTeam = (reg.roleOf(attacker) === RoleId.Traitor) === (reg.roleOf(victim) === RoleId.Traitor);
        if (sameTeam && !b("css_ttt_shop_onedeagle_ff")) {
          hasRevolver[attacker] = 0;
          ev.canceled = true;
          tell(attacker, msg("SHOP_ITEM_DEAGLE_HIT_FF"));
          if (b("css_ttt_shop_onedeagle_kill_shooter_on_ff")) setHealth(attacker, 0);
          return;
        }
        hasRevolver[attacker] = 0; // one shot only, matching the C# RemoveItem on first hit
        ev.damage = 1000;
        tell(victim, msg("SHOP_ITEM_DEAGLE_VICTIM"));
        return;
      }

      // One-Hit Knife: consumed on the next knife strike.
      if (hasOneHitKnife[attacker] === 1 && KNIVES.has(ev.weapon)) {
        const sameTeam = (reg.roleOf(attacker) === RoleId.Traitor) === (reg.roleOf(victim) === RoleId.Traitor);
        if (sameTeam && !b("css_ttt_shop_onehitknife_friendly_fire")) return;
        hasOneHitKnife[attacker] = 0;
        ev.damage = 1000;
        return;
      }

      // Poison Shots: a pistol hit applies poison and consumes a charge.
      if (poisonShots[attacker]! > 0 && ev.weapon.startsWith("weapon_") && isPistol(ev.weapon)) {
        poisonShots[attacker] = poisonShots[attacker]! - 1;
        applyPoison(victim);
        tell(attacker, msg("SHOP_ITEM_POISON_HIT", reg.nameOf(victim)));
        if (poisonShots[attacker] === 0) tell(attacker, msg("SHOP_ITEM_POISON_OUT"));
      }
    },
    { priority: Priority.HIGH },
  );

  // Gloves suppress the DNA trace on a kill.
  eventBus.on("bodyCreate", (ev) => {
    const killer = ev.body.killer;
    if (killer >= 0 && gloveUses[killer]! > 0 && spendGlove(killer, false)) {
      ev.body.dnaSuppressed = true;
    }
  });

  eventBus.on("gameState", (ev) => {
    if (ev.state === GameState.Finished) resetEffects();
  }, { ignoreCanceled: true });
}

/**
 * Does this weapon string count as the One-Shot Revolver?
 *
 * Accepts the configured class and, when that class is the revolver, the `weapon_deagle` the engine
 * actually reports for it.
 */
function isOneShotWeapon(weapon: string): boolean {
  const cls = s("css_ttt_shop_onedeagle_weapon");
  if (weapon === cls) return true;
  return cls === "weapon_revolver" && weapon === "weapon_deagle";
}

/** Pistol test kept local so `effects` does not need the whole inventory tag table. */
function isPistol(weapon: string): boolean {
  switch (weapon) {
    case "weapon_deagle": case "weapon_elite": case "weapon_fiveseven":
    case "weapon_glock": case "weapon_hkp2000": case "weapon_p250":
    case "weapon_usp_silencer": case "weapon_tec9": case "weapon_cz75a":
    case "weapon_revolver":
      return true;
    default:
      return false;
  }
}

/** Announce a player's role to everyone (Stickers). */
function revealRole(slot: number): void {
  const role = reg.roleOf(slot);
  if (role === RoleId.None) return;
  // Reuse the body-identification phrasing so the reveal reads consistently.
  const line = msg("BODY_IDENTIFIED", "Stickers", reg.nameOf(slot), roleName(role));
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) tell(active[i]!, line);
}

