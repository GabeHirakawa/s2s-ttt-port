/**
 * Shop item behaviour — the port of the per-item listeners under `TTT/CS2/Items` and
 * `TTT/Shop/Items` (`PoisonShotsListener`, `GlovesListener`, `StickerListener`,
 * `OneShotDeagleDamageListener`, `TripwireMovementListener`, `TripwireDamageListener`,
 * `HealthStation`, `DamageStation`, `StationItem`, `DnaListener`, `BodyPaintListener`,
 * `ClusterGrenadeListener`, `AbstractCompassItem`, …).
 *
 * Every per-player item flag is a slot-indexed typed array, and every listener is a single
 * subscription on the TTT bus rather than a separate DI-registered class hooking its own game
 * events. The C# spread this across ~40 files, each resolving services from the container and
 * re-reading its config record on each property access.
 *
 * Placed world objects (stations, tripwires, C4) live in small arrays scanned from the plugin's one
 * shared tick — the originals each ran their own repeating timer. {@link onBulletImpact} is the one
 * extra entry point: it is the counter-play against those objects (shoot a wire to pop it safely,
 * shoot a station down) and it scans the same cached positions, so it costs no entity reads.
 */

import { createEntity, type EntityRef } from "@s2script/sdk/entity";
import { Vector } from "@s2script/sdk/math";
import { Trace, TraceMask } from "@s2script/sdk/trace";
import { Sound } from "@s2script/sdk/sound";
import { Beam, Fade, HintText, type BeamHandle } from "@s2script/cs2";
import { Server } from "@s2script/sdk/server";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { b, n, s } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setHealth, tell } from "../cs2/pawn";
import { setEntityColor, setPawnAlpha, type Rgb } from "../cs2/color";
import {
  give, resolveWeapon, weaponClass, KNIVES, PISTOLS, RIFLES, type HeldWeapon,
} from "../cs2/inventory";
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

/**
 * Engine soundevents, copied verbatim from the C# items (`TripwireItem`,
 * `TripwireMovementListener`, `TripwireDefuserListener`, `HealthStation`, `DamageStation`,
 * `PlayerExtensions.DealPoisonDamage`). These are the "is this happening to me" cues — a wire
 * arming, a station draining you, poison ticking — and without them those effects read as bugs.
 *
 * Neither `Sound.emit` nor `Pawn.emitSound` takes a pitch, so the defuse beep's falling pitch ramp
 * (1.5 → 0.5 across the defuse) is the one detail that cannot come across.
 */
const SND_TRIPWIRE_PLACE = "Weapon_ELITE.Clipout";
const SND_TRIPWIRE_ARM = "C4.ExplodeTriggerTrip";
const SND_TRIPWIRE_BLAST = "Flashbang.ExplodeDistant";
const SND_TRIPWIRE_BURN = "Player.BurnDamage";
const SND_DEFUSE_TICK = "c4.keypressquiet";
const SND_DEFUSE_DONE = "c4.disarmfinish";
const SND_STATION_HEAL = "HealthShot.Pickup";
const SND_STATION_HURT = "Player.DamageFall";
const SND_POISON_SELF = "Player.DamageBody.Victim";
const SND_POISON_OTHERS = "Player.DamageBody.Onlooker";

/**
 * Recipient scratch buffers for the sound emissions below.
 *
 * `SoundEmitOptions.recipients` is read synchronously and never retained, so one shared array per
 * shape keeps the per-tick cues allocation-free. Every use writes the slots immediately before the
 * emit — never hold one across a call that could emit again.
 */
const oneSlot: number[] = [0];
const otherSlots: number[] = [];

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
/**
 * 1 when the poison came from a Poison Shot rather than Poison Smoke.
 *
 * Only the Shots path washed the victim's screen (`PoisonShotsListener` called `ColorScreen`;
 * `PoisonSmokeListener` ticked its damage without one), and both sources share one tick loop here.
 */
const poisonFromShots = new Uint8Array(MAX_SLOTS);

/** A placed health/hurt station. */
interface Station {
  /** The visible prop, or null when no model could be spawned (the station still works). */
  ref: EntityRef | null;
  owner: number;
  /** Health delta applied per tick at point-blank range — negative for a hurt station. */
  increment: number;
  /** Total health/damage this station may hand out (0 = unlimited), and how much it already has. */
  budget: number;
  given: number;
  /** Structural health, and what it started at — the damage tint ramps on `health / maxHealth`. */
  health: number;
  maxHealth: number;
  /** Last tint bucket written, so a burst of hits is a couple of entity inputs, not one per bullet. */
  tint: number;
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
  /** Seconds since the last defuse beep — the C# beeped once per `DefuseRate`, not per frame. */
  defuseSound: number;
  alive: boolean;
}

/** Decoration model for a station. Precached at map start; a miss degrades to an invisible station. */
const STATION_MODEL = "models/props/cs_office/microwave.vmdl";

/** C# `StationItem.PROP_SIZE_SQUARED` — how close a bullet must land to count as hitting a station. */
const STATION_HIT_DIST_SQ = 700;

const stations: Station[] = [];
const tripwires: Tripwire[] = [];
let activeC4 = 0;

// ── grant hooks called by the item definitions ───────────────────────────────
/**
 * Grant the Taser scan behaviour, and hand over a FRESH taser.
 *
 * The C# `TaserItem.OnPurchase` removed the weapon before giving it, with the comment "to allow
 * refresh of recharging taser": a plain give is rejected as AlreadyOwned, so without the removal a
 * player who has spent their charge pays again and gets nothing back.
 */
export function grantTaser(slot: number): void {
  hasTaser[slot] = 1;
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  const cls = resolveWeapon(s("css_ttt_shop_taser_weapon"));
  const held = pawn.weapons as HeldWeapon[];
  for (let i = 0; i < held.length; i++) {
    const w = held[i]!;
    if (weaponClass(w) === cls) pawn.removeWeapon(w);
  }
  give(slot, cls);
}
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
  // The tint IS the item. A painted corpse reads as "someone already checked this one", which is
  // what makes Innocents walk past a Traitor's kill; suppressing the identify alone is invisible.
  //
  // C# also flipped RenderMode to kRenderTransAlpha, which has no schema equivalent here, so the
  // `Color` input alone is as close as this gets — the same compromise `cs2/color.ts` documents.
  setEntityColor(body.ref, resolvePaintColor());
  if (left - 1 === 0) tell(slot, msg("SHOP_ITEM_BODY_PAINT_OUT"));
  return true;
}

/**
 * `System.Drawing` colour names `Color.FromName` could resolve, for the Body Paint cvar. Only the
 * handful anyone would plausibly configure — a hex value covers everything else.
 */
const COLOR_NAMES: ReadonlyMap<string, number> = new Map([
  ["greenyellow", 0xadff2f], ["yellow", 0xffff00], ["red", 0xff0000], ["lime", 0x00ff00],
  ["limegreen", 0x32cd32], ["green", 0x008000], ["blue", 0x0000ff], ["dodgerblue", 0x1e90ff],
  ["cyan", 0x00ffff], ["aqua", 0x00ffff], ["magenta", 0xff00ff], ["fuchsia", 0xff00ff],
  ["purple", 0x800080], ["orange", 0xffa500], ["pink", 0xffc0cb], ["gold", 0xffd700],
  ["white", 0xffffff], ["black", 0x000000], ["gray", 0x808080], ["grey", 0x808080],
  ["silver", 0xc0c0c0],
]);

/** `Color.GreenYellow`, the C# default. */
const PAINT_DEFAULT = 0xadff2f;

/** Last raw cvar text parsed, and the triple it produced. */
let paintRaw = "";
const paintColor: Rgb = { r: 0xad, g: 0xff, b: 0x2f };

/**
 * Resolve `css_ttt_shop_bodypaint_color`, mirroring `CS2BodyPaintConfig.Load`: HTML hex first, then
 * a known colour name, then GreenYellow. Memoised on the raw string so repeat paints re-parse
 * nothing; paint is spent on a USE press, well outside the shared frame handler.
 *
 * C#'s `Color.FromName` yields transparent black for an unrecognised name (a black corpse). Falling
 * back to the default instead only differs on a misconfigured server, and fails visibly rather than
 * silently making the item useless.
 */
function resolvePaintColor(): Rgb {
  const raw = s("css_ttt_shop_bodypaint_color");
  if (raw === paintRaw) return paintColor;
  paintRaw = raw;

  const text = raw.trim();
  const hex = text.startsWith("#") ? text.slice(1) : text;
  let rgb: number;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) rgb = parseInt(hex, 16);
  else rgb = COLOR_NAMES.get(text.toLowerCase()) ?? PAINT_DEFAULT;

  paintColor.r = (rgb >> 16) & 0xff;
  paintColor.g = (rgb >> 8) & 0xff;
  paintColor.b = rgb & 0xff;
  return paintColor;
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
 * Place a station in front of `slot`. `increment` is the per-tick health delta at point-blank range
 * (negative for the Traitor hurt station); `budget` is the total it may hand out before it expires.
 *
 * The visible prop is best-effort: a station is fundamentally a position plus a radius, so if the
 * decoration model will not spawn on this map the station is still placed and still works. The C#
 * version aborted the whole purchase if the entity failed.
 */
export function placeStation(slot: number, increment: number, budget?: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null) return;
  const hit = pawn.aimTrace({ distance: 128, mask: TraceMask.WorldOnly });
  const at = hit?.endPos ?? pawn.origin;
  if (at === null || at === undefined) return;

  // The prop is spawned effectively unbreakable and torn down by the script instead. The C# tracked
  // `StationInfo.Health` itself and fired `AcceptInput("Kill")` at zero; letting the ENGINE own
  // break damage as well would let the two drift — the prop popping while the script still thinks
  // it is pristine, or sitting there deep-red long after the script wrote it off.
  const ent = createEntity("prop_physics_override", {
    model: STATION_MODEL,
    targetname: `ttt_station_${slot}`,
    health: 1_000_000,
  });
  // Store the position the prop actually ends up at, so the bullet-impact test and the effect
  // radius agree — the C# used one `AbsOrigin` for both.
  const z = at.z + 8;
  ent?.teleport([at.x, at.y, z], null, [0, 0, 0]);

  const maxHealth = n("css_ttt_shop_healthstation_station_health");
  stations.push({
    ref: ent,
    owner: slot,
    increment,
    // C# exposes no ConVar for the hurt station's allowance — `DamageStationConfig` hard-codes
    // -3000 — so a caller that does not pass one gets the budget implied by the sign of the
    // increment, with `css_ttt_shop_damagestation_total_damage` able to override it if registered.
    budget: budget ?? (increment < 0
      ? n("css_ttt_shop_damagestation_total_damage") || 3000
      : Math.abs(n("css_ttt_shop_healthstation_total_health_given"))),
    given: 0,
    health: maxHealth,
    maxHealth,
    tint: -1,
    x: at.x,
    y: at.y,
    z,
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

    // The budget is tested at the START of an interval, as the C# did: the tick that exhausts it
    // still lands in full on everyone in range, and the station only disappears afterwards.
    if (st.budget > 0 && st.given > st.budget) {
      st.ref?.remove();
      stations.splice(i, 1);
      continue;
    }

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
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > rangeSq) continue;

      // Linear falloff to nothing at the rim (`ComputePotentialHeal` / `DamageStation`'s
      // `healthScale`). Standing at the edge of a Detective's station should barely do anything —
      // a flat effect out to the full radius makes both stations far stronger than the original.
      // The rounding is asymmetric in the C# too: a heal ceils, damage floors then takes magnitude.
      const scale = 1 - Math.sqrt(distSq) / range;
      let amount = heals
        ? Math.ceil(st.increment * scale)
        : -Math.abs(Math.floor(st.increment * scale));
      if (amount === 0) continue;

      const hp = pawn.health ?? 0;
      if (heals) {
        // Cap at max health: writing past it would permanently RAISE max health (see `setHealth`).
        const room = (pawn.maxHealth ?? 100) - hp;
        if (room <= 0) continue;
        if (amount > room) amount = room;
      }

      // Emitted before the write, because a lethal `setHealth` slays the pawn this cue plays from.
      if (heals) {
        pawn.emitSound(SND_STATION_HEAL, { volume: 0.1 });
      } else {
        oneSlot[0] = slot;
        pawn.emitSound(SND_STATION_HURT, { recipients: oneSlot, volume: 0.2 });
      }
      setHealth(slot, hp + amount);
      st.given += amount < 0 ? -amount : amount;
    }
  }
}

// ── shooting placed gadgets ──────────────────────────────────────────────────
/**
 * A bullet landed at (x, y, z), fired by `shooter`.
 *
 * This is the counter-play the C# had against placed gadgets: pop a tripwire from across the room
 * instead of walking into it, and shoot a Detective's health station or a Traitor's hurt station
 * down. Both scans read the cached placement positions, so a round with nothing placed pays two
 * length checks per bullet.
 */
export function onBulletImpact(shooter: number, x: number, y: number, z: number): void {
  if (tripwires.length !== 0) shootTripwire(x, y, z);
  if (stations.length !== 0) shootStation(shooter, x, y, z);
}

/** Detonate the nearest tripwire if the bullet landed on its anchor. */
function shootTripwire(x: number, y: number, z: number): void {
  const sizeSq = n("css_ttt_shop_tripwire_size_squared");
  let best = -1;
  let bestSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tripwires.length; i++) {
    const tw = tripwires[i]!;
    // Un-armed wires are not shootable: in the C# an instance only entered `ActiveTripwires` once
    // its initiation time had elapsed, so nothing could set one off during placement.
    if (!tw.alive || tw.arming > 0) continue;
    const dx = tw.ax - x, dy = tw.ay - y, dz = tw.az - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestSq) { bestSq = d; best = i; }
  }
  if (best < 0 || bestSq > sizeSq) return;

  const tw = tripwires[best]!;
  detonateTripwire(tw);
  tw.alive = false;
}

/** Take a bullet off the nearest station's structural health, tinting or killing it. */
function shootStation(shooter: number, x: number, y: number, z: number): void {
  let best = -1;
  let bestSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i]!;
    const dx = st.x - x, dy = st.y - y, dz = st.z - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestSq) { bestSq = d; best = i; }
  }
  if (best < 0 || bestSq > STATION_HIT_DIST_SQ) return;

  const st = stations[best]!;
  st.health -= bulletDamage(shooter, x, y, z);
  if (st.health <= 0) {
    st.ref?.acceptInput("Kill");
    stations.splice(best, 1);
    return;
  }

  // White at full health, fading to blue (health station) or red (hurt station) as it is shot — the
  // "one more magazine and it's gone" read that tells attackers and defenders whether it is worth
  // contesting. Quantised so a spray costs a handful of entity inputs rather than one per bullet.
  if (st.ref === null) return;
  const frac = st.health / st.maxHealth;
  const bucket = Math.round(frac * 16);
  if (bucket === st.tint) return;
  st.tint = bucket;
  const c = Math.round(255 * frac);
  if (st.increment > 0) {
    tintScratch.r = c; tintScratch.g = c; tintScratch.b = 255;
  } else {
    tintScratch.r = 255; tintScratch.g = c; tintScratch.b = c;
  }
  setEntityColor(st.ref, tintScratch);
}

/** Reused colour triple for the station tint — `setEntityColor` formats it and keeps nothing. */
const tintScratch: Rgb = { r: 255, g: 255, b: 255 };

/** SMGs and shotguns, split out of the port's `RIFLES` union for the station damage tiers. */
const SMG_CLASSES: ReadonlySet<string> = new Set([
  "weapon_bizon", "weapon_mac10", "weapon_mp5sd", "weapon_mp7", "weapon_mp9",
  "weapon_p90", "weapon_ump45",
]);
const SHOTGUN_CLASSES: ReadonlySet<string> = new Set([
  "weapon_mag7", "weapon_nova", "weapon_sawedoff", "weapon_xm1014",
]);

/**
 * What one bullet takes off a station — the C# `getBulletDamage`, distance scale included.
 *
 * The tiers are inlined rather than driven off `cs2/inventory`'s tag sets because the exported
 * `RIFLES` there is the same union the C# `Tag.RIFLES` was, and the narrow SMG/shotgun tiers the
 * table needs before it are module-private over there. Order matters: matching against the union
 * first would score every SMG as a rifle (35 instead of 15).
 */
function bulletDamage(shooter: number, x: number, y: number, z: number): number {
  let cls = "";
  let dist = 1;
  const pawn = shooter < 0 ? null : pawnOf(shooter);
  if (pawn !== null) {
    cls = weaponClass(pawn.activeWeapon as HeldWeapon | null);
    const o = pawn.origin;
    if (o !== null) {
      const dx = o.x - x, dy = o.y - y, dz = o.z - z;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    }
  }
  const scale = Math.max(0.1, Math.min(1, 256 / dist));
  return Math.max(1, Math.trunc(baseBulletDamage(cls) * scale));
}

/** The C# `getBaseDamage` table. */
function baseBulletDamage(cls: string): number {
  switch (cls) {
    case "weapon_awp": return 115;
    case "weapon_glock": return 8;
    case "weapon_usp_silencer": return 20;
    case "weapon_deagle": return 40;
    default: break;
  }
  if (PISTOLS.has(cls)) return 10;
  if (SMG_CLASSES.has(cls) || SHOTGUN_CLASSES.has(cls)) return 15;
  if (RIFLES.has(cls)) return 35;
  return 5;
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
  // The C# emitted the wire's whole audible life from its `prop_dynamic`; this port has no prop, so
  // the beam entity is the sound source. Only positional emits — an entity-less `Sound.emit` is a
  // global 2D broadcast, which would tell the whole server a wire just went down.
  if (beam !== null) Sound.emit(SND_TRIPWIRE_PLACE, { entity: beam.ref });

  tripwires.push({
    owner: slot,
    beam,
    ax: start.x, ay: start.y, az: start.z,
    bx: end.x, by: end.y, bz: end.z,
    arming: n("css_ttt_shop_tripwire_initiation_time"),
    defuseProgress: 0,
    defuser: -1,
    defuseSound: 0,
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
      // The audible "a trap just went live" warning, on the frame the wire actually arms. In the C#
      // the beam did not exist until this moment, so this beep was the only cue either way.
      if (tw.arming <= 0 && tw.beam !== null) {
        Sound.emit(SND_TRIPWIRE_ARM, { entity: tw.beam.ref });
      }
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

      detonateTripwire(tw);
      tw.alive = false;
      break;
    }
  }
}

/** Blow a tripwire, damaging everyone within its falloff radius. */
function detonateTripwire(tw: Tripwire): void {
  const power = n("css_ttt_shop_tripwire_explosion_power");
  const falloff = n("css_ttt_shop_tripwire_falloff_delay");
  const ffMult = n("css_ttt_shop_tripwire_friendlyfire_multiplier");
  if (tw.beam !== null) Sound.emit(SND_TRIPWIRE_BLAST, { entity: tw.beam.ref });

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    // Measured from the ANCHOR the wire was pinned to (`TripwireInstance.StartPos`), not from the
    // middle of its span.
    const dx = o.x - tw.ax, dy = o.y - tw.ay, dz = o.z - tw.az;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Exponential decay (`getDamage`). A hyperbolic curve looks similar at the wire and is wildly
    // wrong past it: at stock power/falloff this is ~223 damage at 100u and single digits by 300u,
    // where `power / (1 + dist * falloff)` still does three figures clear across a room.
    let damage = power * Math.exp(-dist * falloff);
    // Scaled for every Traitor, including whoever tripped it — the C# keyed the multiplier purely
    // on the victim's role and made no exception for the triggerer.
    if (reg.roleOf(slot) === RoleId.Traitor) damage *= ffMult;
    // Floor AFTER the multiplier, then drop sub-1 hits: `getDamage` returns the floored value and
    // `dealTripwireDamage` is what rejects `< 1`. Guarding first would let a fringe Traitor take 1
    // where the original takes none.
    const dealt = Math.floor(damage);
    if (dealt < 1) continue;
    // Emitted before the write, because a lethal `setHealth` slays the pawn this cue plays from.
    pawn.emitSound(SND_TRIPWIRE_BURN);
    setHealth(slot, (pawn.health ?? 0) - dealt);
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
      if (tw.beam !== null) Sound.emit(SND_DEFUSE_DONE, { entity: tw.beam.ref, volume: 0.2 });
      addBalance(slot, n("css_ttt_shop_tripwire_defuse_reward"), "Defused Tripwire");
      return true;
    }
    // The C# defuse ran on its own `DefuseRate` timer and beeped once per tick; this runs off the
    // USE handler every frame, so the beep is paced back to that rate by hand.
    tw.defuseSound += dt;
    if (tw.defuseSound >= Math.max(0.05, n("css_ttt_shop_tripwire_defuse_rate"))) {
      tw.defuseSound = 0;
      oneSlot[0] = slot;
      pawn.emitSound(SND_DEFUSE_TICK, { recipients: oneSlot });
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
 * Apply poison to `victim`. `fromShots` marks the Poison Shots source, which is the only one that
 * washes the victim's screen.
 *
 * NOTE: poison damage is applied by writing health, which the engine attributes to nobody — so a
 * poison kill is not credited to the Traitor who threw the smoke. The C# had the same limitation
 * (it also drove the damage through a direct health write).
 */
export function applyPoison(victim: number, fromShots = false): void {
  poisonRemaining[victim] = n("css_ttt_shop_poisonsmoke_poison_total_damage");
  poisonTimer[victim] = 0;
  poisonFromShots[victim] = fromShots ? 1 : 0;
}

/**
 * The purple pulse a poisoned player gets per tick — `ColorScreen(PoisonColor, 0.2f, 0.3f)`, which
 * is how the victim learns they are poisoned rather than watching their health drain in silence.
 *
 * The wire values are the C#'s own: `PlayerExtensions.ColorScreen` scaled seconds by 512 (0.3s fade
 * → 154, 0.2s hold → 102) and defaulted to FADE_IN | PURGE. They are passed through verbatim so
 * what the client receives is byte-for-byte what the original sent.
 *
 * `cs2/feedback.ts`'s role flash converts with `1 << 12` for the same field. The two disagree about
 * the engine's fade units; these constants are the ones that reproduce the behaviour being ported.
 */
const POISON_FADE_DURATION = 154;
const POISON_FADE_HOLD = 102;
/** FADE_IN (0x0001) | FADE_PURGE (0x0010) — `ColorScreen`'s defaults. */
const POISON_FADE_FLAGS = 0x0011;
/** `Color.FromArgb(128, Color.Purple)` = R128 G0 B128 A128, packed R-low as `ColorScreen` packed it. */
const POISON_FADE_COLOR = (128 | (128 << 16) | (128 << 24)) >>> 0;

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

    // `DealPoisonDamage` paired every tick with a hurt grunt: loud to the victim, quieter to
    // everyone else — which is how a poisoned player is heard dying around a corner.
    oneSlot[0] = slot;
    pawn.emitSound(SND_POISON_SELF, { recipients: oneSlot, volume: 0.2 });
    otherSlots.length = 0;
    for (let j = 0; j < active.length; j++) {
      const other = active[j]!;
      if (other !== slot) otherSlots.push(other);
    }
    if (otherSlots.length !== 0) {
      pawn.emitSound(SND_POISON_OTHERS, { recipients: otherSlots, volume: 0.2 });
    }
    if (poisonFromShots[slot] === 1) {
      Fade.to(slot, {
        duration: POISON_FADE_DURATION,
        holdTime: POISON_FADE_HOLD,
        color: POISON_FADE_COLOR,
        flags: POISON_FADE_FLAGS,
      });
    }

    setHealth(slot, (pawn.health ?? 0) - damage);
  }
}

// ── compass ──────────────────────────────────────────────────────────────────
let compassAccum = 0;

/** Filler cell — the C# `TextCompass` default. */
const COMPASS_FILLER = "·";
/** Reused strip buffer; reallocated only when the configured width changes. */
let compassBuf: string[] = [];

/**
 * Render a text compass strip for anyone holding one.
 *
 * Only the NEAREST target is marked, and only when one is actually in range — the C# picked a
 * single target with `GetNearestVector` and returned without printing when nothing qualified.
 * Bailing out is also what keeps the compass off the hint-text channel it shares with the
 * name tooltip (`cs2/handlers.ts`) and the tripwire defuse bar: an unconditional 4 Hz write would
 * mean a compass owner never sees either again.
 */
function tickCompass(dt: number): void {
  compassAccum += dt;
  if (compassAccum < 0.25) return;
  compassAccum = 0;

  const length = n("css_ttt_shop_compass_length");
  const fov = Math.max(0.001, Math.min(360, n("css_ttt_shop_compass_fov")));
  const range = n("css_ttt_shop_compass_max_range");
  const rangeSq = range * range;
  if (compassBuf.length !== length) compassBuf = new Array<string>(length);

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

    let bestSq = rangeSq;
    let tx = 0;
    let ty = 0;
    let found = false;

    if (mode === CompassMode.Players) {
      // Enemies only: `enemies = requesterIsTraitor ? allies : traitors`. Without this the Traitor
      // compass marks fellow Traitors and the strip is mostly false hits.
      const meTraitor = reg.roleOf(slot) === RoleId.Traitor;
      for (let j = 0; j < active.length; j++) {
        const other = active[j]!;
        if (other === slot || !reg.isAlive(other)) continue;
        if ((reg.roleOf(other) === RoleId.Traitor) === meTraitor) continue;
        const p = pawnOf(other);
        const po = p === null ? null : p.origin;
        if (po === null) continue;
        const dx = po.x - o.x, dy = po.y - o.y, dz = po.z - o.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d >= bestSq) continue;
        bestSq = d; tx = po.x; ty = po.y; found = true;
      }
    } else {
      const bodies = allBodies();
      for (let j = 0; j < bodies.length; j++) {
        const body = bodies[j]!;
        // A corpse someone has already identified stops being a lead, and bodies are never removed
        // from the round's list — without this the Detective compass points at solved cases.
        if (body.identified) continue;
        const dx = body.x - o.x, dy = body.y - o.y, dz = body.z - o.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d >= bestSq) continue;
        bestSq = d; tx = body.x; ty = body.y; found = true;
      }
    }
    if (!found) continue;

    // `AdjustGameAngle`: game yaw (0 = +X, counter-clockwise) → compass bearing (0 = North,
    // clockwise). Applied to viewer and target alike, so the two mostly cancel — what it really
    // buys is putting N/E/S/W where a player expects them.
    const viewYaw = adjustGameAngle(ang.y);
    const targetYaw = adjustGameAngle((Math.atan2(ty - o.y, tx - o.x) * 180) / Math.PI);

    for (let c = 0; c < length; c++) compassBuf[c] = COMPASS_FILLER;
    const start = viewYaw - fov / 2;
    place(compassBuf, fov, start, 0, "N");
    place(compassBuf, fov, start, 90, "E");
    place(compassBuf, fov, start, 180, "S");
    place(compassBuf, fov, start, 270, "W");
    place(compassBuf, fov, start, targetYaw, "X");

    HintText.to(slot, `${compassBuf.join("")} ${distanceBand(Math.sqrt(bestSq))}`);
  }
}

/** `AbstractCompassItem.AdjustGameAngle`. */
function adjustGameAngle(angle: number): number {
  return 360 - ((angle + 360) % 360) + 90;
}

/** Wrap to [0, 360). */
function norm360(angle: number): number {
  const a = angle % 360;
  return a < 0 ? a + 360 : a;
}

/**
 * Drop `glyph` on the strip cell for `bearing`, or leave it off when that bearing falls outside the
 * viewed arc. A collision nudges outwards to the nearest free cell instead of overwriting, so the
 * target X never silently eats a cardinal (`TextCompass.PlaceIfVisible`).
 */
function place(buf: string[], fov: number, start: number, bearing: number, glyph: string): void {
  const width = buf.length;
  const delta = norm360(bearing - start);
  if (delta >= fov) return;

  let idx = Math.round(delta / (fov / width));
  if (idx < 0) idx = 0;
  if (idx >= width) idx = width - 1;
  if (buf[idx] === COMPASS_FILLER) { buf[idx] = glyph; return; }

  const maxRadius = Math.max(idx, width - 1 - idx);
  for (let r = 1; r <= maxRadius; r++) {
    const left = idx - r;
    if (left >= 0 && buf[left] === COMPASS_FILLER) { buf[left] = glyph; return; }
    const right = idx + r;
    if (right < width && buf[right] === COMPASS_FILLER) { buf[right] = glyph; return; }
  }
  buf[idx] = glyph;
}

/**
 * The readout beside the strip — `GetDistanceDescription`. Hard-coded English in the original too
 * (it never went through the localiser), so it is inlined rather than given a phrase key.
 */
function distanceBand(distance: number): string {
  if (distance > 2000) return "AWP Distance";
  if (distance > 1500) return "Scout Distance";
  if (distance > 1000) return "Rifle Distance";
  if (distance > 500) return "Pistol";
  if (distance > 250) return "Nearby";
  return "Knife Range";
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
  poisonFromShots.fill(0);
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

      // Poison Shots: a pistol hit applies poison and consumes a charge. This is the source that
      // flashes the victim's screen; Poison Smoke (in `weaponfx.ts`) is the silent one.
      if (poisonShots[attacker]! > 0 && ev.weapon.startsWith("weapon_") && isPistol(ev.weapon)) {
        poisonShots[attacker] = poisonShots[attacker]! - 1;
        applyPoison(victim, true);
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
