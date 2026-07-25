/**
 * Game-event-driven item behaviour — the port of `SilentAWPItem`'s sound hook, `DnaListener`,
 * `PoisonShotsListener`, `PoisonSmokeListener`, `ClusterGrenadeListener` and the C4 item.
 *
 * These are the items whose effect is triggered by an engine event rather than by damage. They live
 * apart from `effects.ts` because they share one `CMsgTEFireBullets` interception between the Silent
 * AWP, the Suppressed special round and Poison Shots — the C# hooked user message 452 separately
 * from each (`SilentAWPItem`, `SuppressedRound`, `PoisonShotsListener`), re-hooking and unhooking
 * per round.
 *
 * Poison Smoke clouds and Cluster Grenade fragments are world effects with their own lifetime, so
 * they sit in small arrays drained by `tickWeaponFx` — the same shape as `effects.ts`'s stations and
 * tripwires. The originals each ran their own `SchedulePeriodic` timer (Poison Smoke) or leaned on
 * the engine's grenade fuse (Cluster).
 */

import { UserMessages, type UserMessageView } from "@s2script/sdk/usermessages";
import { HookResult, type HookResultValue } from "@s2script/sdk/events";
import { Server } from "@s2script/sdk/server";
import { Sound } from "@s2script/sdk/sound";
import { Vector } from "@s2script/sdk/math";
import { Trace, TraceMask } from "@s2script/sdk/trace";
import { ChatColors } from "@s2script/cs2";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { n, s } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setHealth, tell } from "../cs2/pawn";
import { PISTOLS } from "../cs2/inventory";
import type { Body } from "../cs2/bodies";
import { ownsDnaScanner } from "./effects";
import { inProgress } from "../game/game";

/** Remaining silenced shots per slot (Silent AWP). */
const silentShots = new Int32Array(MAX_SLOTS);
/**
 * Remaining poisoned shots per slot.
 *
 * Lives here rather than in `effects.ts` because a charge is spent on FIRE, not on hit: both the
 * `weapon_fire` consumption and the fire-sound suppression that reads the same counter are in this
 * file. `effects.ts` only reads it, to decide whether a landed pistol hit poisons.
 */
const poisonShots = new Int32Array(MAX_SLOTS);
/** Slots holding a live Poison Smoke charge. */
const poisonSmoke = new Uint8Array(MAX_SLOTS);
/** Slots holding a live Cluster Grenade charge. */
const clusterCharge = new Uint8Array(MAX_SLOTS);
/**
 * When each slot last got a DNA reading on a given body — throttles the message.
 *
 * Keyed on a packed `slot * 65536 + entityIndex` integer rather than the C#'s `player.Id + "." +
 * body.Id` string: this is on the USE-press path, and entity indices never reach 65536.
 */
const lastDnaRead = new Map<number, number>();

/** Flavour text for a body with no recoverable DNA, as the C# `missingDnaExplanations`. */
const NO_DNA: readonly string[] = [
  "the killer used gloves... for their bullets",
  "the killer was very careful",
  "the killer wiped the weapon clean",
  "the killer retrieved the bullets",
  "the bullets disintegrated on impact",
  "the killer was GOATed",
  "but no DNA was found",
  "but legal litigation caused the DNA to be lost",
  "and confirmed they were dead",
  "and they will remember that",
  "good job",
];

/** Grant `count` silenced shots to a slot. */
export function grantSilentShots(slot: number, count: number): void {
  silentShots[slot] = count;
}
/** Grant `count` poisoned shots to a slot. */
export function grantPoisonShots(slot: number, count: number): void {
  poisonShots[slot] = count;
}
/** How many poisoned shots this slot has left — read by the damage listener in `effects.ts`. */
export function poisonShotsLeft(slot: number): number {
  return poisonShots[slot]!;
}
/** Arm a Poison Smoke charge. */
export function armPoisonSmoke(slot: number): void {
  poisonSmoke[slot] = 1;
}
/** Arm a Cluster Grenade charge. */
export function armCluster(slot: number): void {
  clusterCharge[slot] = 1;
}
/** Apply the configured C4 fuse length. */
export function applyC4Fuse(): void {
  Server.setCvar("mp_c4timer", String(n("css_ttt_shop_c4_fuse_time")));
}

/** True while the Suppressed special round wants pistol fire silenced. */
let suppressPistols = false;

/** Turn the Suppressed round's pistol silencing on or off. */
export function setSuppressPistols(on: boolean): void {
  suppressPistols = on;
}

/** Pistol item-definition indices, as the C# `WeaponSoundIndex.PISTOLS`. */
const PISTOL_DEFS: ReadonlySet<number> = new Set([1, 2, 3, 30, 32, 36, 4, 61, 63, 64]);

let hooked = false;

/**
 * Install the single fire-sound interception shared by the Silent AWP, the Suppressed round and
 * Poison Shots.
 *
 * The shooter is resolved the way the C# did: the message carries the bullet origin, which is the
 * shooter's eye position, so the nearest matching eye position identifies them. It is a hack in both
 * versions — the message simply does not carry a player id — but it is exact in practice because
 * only the firing player is at that coordinate.
 */
export function installFireHook(): void {
  if (hooked) return;
  hooked = true;
  try {
    UserMessages.onPre("CMsgTEFireBullets", (m): HookResultValue | void => {
      const def = m.readInt("weapon_id") ?? m.readInt("item_def_index");
      const isPistolDef = def !== null && PISTOL_DEFS.has(def);

      if (suppressPistols && isPistolDef) return HookResult.Handled;

      const shooter = shooterOf(m);
      if (shooter < 0) return;

      // Poison Shots silences the pistol for as long as charges remain — the item's defining
      // property. Must be tested BEFORE the Silent AWP's early return below, or it would only ever
      // fire for someone who also happens to own the AWP.
      if (isPistolDef && poisonShots[shooter]! > 0) return HookResult.Handled;

      if (silentShots[shooter]! <= 0) return;

      // Only silence the Silent AWP's own weapon.
      const awpDef = n("css_ttt_shop_silentawp_index");
      if (def !== null && def !== awpDef) return;

      silentShots[shooter] = silentShots[shooter]! - 1;
      return HookResult.Handled;
    });
  } catch {
    console.warn("[ttt] fire-bullets message unavailable: Silent AWP and Suppressed are inert");
  }
}

/** Resolve the firing player from the message's bullet origin. */
function shooterOf(m: UserMessageView): number {
  const x = m.readFloat("origin.x");
  const y = m.readFloat("origin.y");
  const z = m.readFloat("origin.z");
  if (x === null || y === null || z === null) return -1;

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    // Eye height is ~64u above the body origin; the C# compared against `GetEyePosition()`.
    const dx = o.x - x;
    const dy = o.y - y;
    const dz = o.z + 64 - z;
    if (dx * dx + dy * dy + dz * dz < 4) return slot;
  }
  return -1;
}

/**
 * A shot was fired. Poison Shots burns a charge on every pistol TRIGGER PULL, hit or miss, as the
 * C# `PoisonShotsListener.OnFire` did — five charges are five shots, not five guaranteed poisonings.
 *
 * `weapon_fire` is dispatched before `player_hurt`, so the shot that spends the LAST charge finds a
 * zeroed counter by the time the hit lands and does not poison. That looks like an off-by-one but it
 * is exactly what the original does: `usePoisonShot` removes the item on reaching zero, and
 * `OnDamage` then fails its `shots > 0` lookup.
 */
export function onWeaponFire(slot: number, weapon: string): void {
  if (slot < 0) return;
  const left = poisonShots[slot]!;
  if (left <= 0) return;
  // `weapon_fire` reports a bare weapon name ("glock"); the tag tables hold full classes.
  const cls = weapon === "" ? "" : weapon.startsWith("weapon_") ? weapon : `weapon_${weapon}`;
  if (!PISTOLS.has(cls)) return;

  poisonShots[slot] = left - 1;
  if (left - 1 === 0) tell(slot, msg("SHOP_ITEM_POISON_OUT"));
}

// ── poison smoke clouds ──────────────────────────────────────────────────────
/**
 * A live poison cloud. Damage is re-targeted from the CLOUD's position every tick, so walking out
 * saves you and walking in catches you, and the budget is shared by everyone the cloud ever hits.
 */
interface Cloud {
  /**
   * Who threw it. Carried for attribution only — the damage is a direct health write, which the
   * engine credits to nobody. The C# had the same limitation for gadget damage.
   */
  owner: number;
  x: number;
  y: number;
  z: number;
  radiusSq: number;
  /** Damage the cloud has left to give IN TOTAL — the C# `TotalDamage - effect.DamageGiven`. */
  budget: number;
  /** Seconds until the next damage tick. */
  timer: number;
  /** Seconds of cloud left. */
  life: number;
  /** Entity index of the smoke projectile, or -1 if the caller did not supply one. */
  entity: number;
}

/**
 * How long a cloud keeps poisoning, in seconds.
 *
 * The C# ticked for as long as `effect.Projectile.IsValid`. There is no entity-by-index lookup in
 * the SDK (`Entity` exposes only `findByClass`, which allocates and cannot tell two smokes apart),
 * so the cloud runs on the smoke's own ~18s lifetime instead, cut short by `smokegrenade_expired`
 * when that event is wired through.
 */
const SMOKE_LIFETIME = 18;

const clouds: Cloud[] = [];

// ── cluster grenade fragments ────────────────────────────────────────────────
/**
 * Fragment damage falloff.
 *
 * The C# spawned real `CHEGrenadeProjectile`s and let the engine's own explosion do the damage, so
 * neither version has a config for this — there is nothing to read from a cvar. These are the port's
 * numbers, kept as they were: with the fuse and the occlusion check below, the fragments are now
 * survivable, which is what the item's counter-play depends on.
 */
const FRAG_DAMAGE = 40;
const FRAG_RADIUS = 250;
/** CS2's HE fuse — the window a victim gets to break line of sight, as in the original. */
const FRAG_FUSE = 1.5;
/**
 * Per-fragment fuse stagger. Real fragments bounce differently and cook off a few frames apart;
 * spreading them also keeps the occlusion traces off a single frame.
 */
const FRAG_STAGGER = 0.08;
/** Source units/s². Used to work out where a fragment first hits the floor. */
const GRAVITY = 800;
/** Ceiling on live fragments — two Traitors detonating at once must not grow an array unbounded. */
const MAX_FRAGMENTS = 128;

// Packed, index-parallel: the drain runs every frame and must not allocate.
const fragX = new Float32Array(MAX_FRAGMENTS);
const fragY = new Float32Array(MAX_FRAGMENTS);
const fragZ = new Float32Array(MAX_FRAGMENTS);
const fragFuse = new Float32Array(MAX_FRAGMENTS);
let fragCount = 0;

/** Reset every per-round charge and every live world effect. */
export function resetWeaponFx(): void {
  silentShots.fill(0);
  poisonShots.fill(0);
  poisonSmoke.fill(0);
  clusterCharge.fill(0);
  lastDnaRead.clear();
  clouds.length = 0;
  // Fragments must never cook off into the next round.
  fragCount = 0;
}

/** Register the event-driven item behaviours. */
export function installWeaponFx(bus: EventBus<TttEvents>): void {
  installFireHook();

  // The C# listeners each cleared their own state on `GameStateUpdateEvent(FINISHED)` — poison
  // timers, the DNA cooldown table, the per-player shot counters. Without this, charges and live
  // clouds would leak into the next round.
  bus.on(
    "gameState",
    (ev) => {
      if (ev.state === GameState.Finished) resetWeaponFx();
    },
    { ignoreCanceled: true },
  );
}

// ── DNA scanner ──────────────────────────────────────────────────────────────
/** Seconds before the same player can re-read the same body (the C# `cooldown`). */
const DNA_COOLDOWN = 15;

/** Chat colour a role's name reads in — the C# `GameMsgs.GetRolePrefix`. */
function rolePrefix(role: RoleId): string {
  return role === RoleId.Traitor
    ? ChatColors.Red
    : role === RoleId.Detective
      ? ChatColors.DarkBlue
      : ChatColors.Lime;
}

/**
 * Read the DNA off a body for `slot`.
 *
 * Driven by the USE press on a corpse, NOT by identification. In the C# this was a second,
 * independent subscriber on `PropPickupEvent` (`DnaListener`, Priority.LOW) sitting beside
 * `BodyPickupListener` — so it fires on a body someone else already called out, on a body the
 * scanner is carrying with Gloves, and repeatedly on the same body. Its only rate limit is the
 * 15-second per (player, body) cooldown below; it has no round-state gate either.
 */
export function readDna(slot: number, body: Body): void {
  if (slot < 0 || !ownsDnaScanner(slot)) return;
  // The C# bailed when the victim had no role — nothing to colour the reading with.
  if (body.ownerRole === RoleId.None) return;

  const key = slot * 65536 + body.index;
  const now = Server.gameTime;
  const last = lastDnaRead.get(key);
  if (last !== undefined && now - last < DNA_COOLDOWN) return;
  lastDnaRead.set(key, now);

  const roleColour = rolePrefix(body.ownerRole);
  if (now - body.timeOfDeath > n("css_ttt_shop_dna_decay_time")) {
    tell(slot, msg("SHOP_ITEM_DNA_EXPIRED", roleColour, body.ownerName));
    return;
  }
  // Order matters and follows the C#: a wiped trace (`body.Killer == null`) is reported before the
  // suicide case, so Gloves still read as "no DNA" rather than "they killed themselves".
  if (body.dnaSuppressed || body.killer < 0) {
    const why = NO_DNA[(Math.random() * NO_DNA.length) | 0]!;
    tell(slot, msg("SHOP_ITEM_DNA_SCANNED_OTHER", roleColour, body.ownerName, why));
    return;
  }
  // `SHOP_ITEM_DNA_SCANNED_SUICIDE` in the C# is just `SCANNED_OTHER` with a fixed explanation.
  if (body.killer === body.owner) {
    tell(
      slot,
      msg("SHOP_ITEM_DNA_SCANNED_OTHER", roleColour, body.ownerName, "they killed themselves"),
    );
    return;
  }
  tell(slot, msg("SHOP_ITEM_DNA_SCANNED", roleColour, body.ownerName, body.killerName));
}

// ── grenades ─────────────────────────────────────────────────────────────────
/**
 * A smoke grenade detonated. If the thrower armed Poison Smoke, the cloud becomes a live world
 * effect: anyone inside it who is an Innocent or a Detective takes a tick of poison, drawn from one
 * pool shared by the whole cloud.
 *
 * `entityId` is the projectile index from the event, used only to match a later
 * `smokegrenade_expired`; the cloud still self-expires without it.
 */
export function onSmokeDetonate(
  thrower: number,
  x: number,
  y: number,
  z: number,
  entityId = -1,
): void {
  if (thrower < 0 || poisonSmoke[thrower] !== 1 || !inProgress()) return;
  poisonSmoke[thrower] = 0;

  const radius = n("css_ttt_shop_poisonsmoke_radius");
  clouds.push({
    owner: thrower,
    x,
    y,
    z,
    radiusSq: radius * radius,
    budget: n("css_ttt_shop_poisonsmoke_poison_total_damage"),
    timer: 0,
    life: SMOKE_LIFETIME,
    entity: entityId,
  });
}

/** The smoke cloud for `entityId` dispersed — its poison goes with it. */
export function onSmokeExpired(entityId: number): void {
  if (entityId < 0) return;
  for (let i = clouds.length - 1; i >= 0; i--) {
    if (clouds[i]!.entity === entityId) clouds.splice(i, 1);
  }
}

/**
 * An HE grenade detonated. If the thrower armed a Cluster Grenade, scatter its fragments around the
 * epicentre and leave them to cook off on their own fuse.
 *
 * The C# spawned `config.GrenadeCount` real `CHEGrenadeProjectile`s through a CounterStrikeSharp
 * signature helper (`GrenadeDataHelper.CreateGrenade`) with a circular velocity, and the engine flew
 * them, bounced them and exploded them. s2script has no projectile-construction path, so the
 * fragments are simulated: each one is placed where a grenade thrown at that velocity would first
 * hit the floor, then detonates a fuse later with a line-of-sight check. That keeps the two things
 * the item's counter-play depends on — a window to run, and cover that actually works.
 */
export function onHeDetonate(thrower: number, x: number, y: number, z: number): void {
  if (thrower < 0 || clusterCharge[thrower] !== 1 || !inProgress()) return;
  clusterCharge[thrower] = 0;

  const count = n("css_ttt_shop_clustergrenade_count");
  const throwForce = n("css_ttt_shop_clustergrenade_throw_force");
  const upForce = n("css_ttt_shop_clustergrenade_up_force");

  // Ballistic settle distance. A fragment leaves at (cos·throw, sin·throw, up) and gravity returns
  // it to the blast plane after 2·up/g seconds, so that is how far out it is when it first lands —
  // ~125u with the stock 250/200. This is the only honest use for `up_force`: there is no
  // projectile to give a velocity to, and applying it as a static Z offset would just park every
  // fragment above head height.
  const settle = (throwForce * 2 * upForce) / GRAVITY;
  // Trace from just above the blast so the ray does not start inside the floor.
  const from = new Vector(x, y, z + 8);

  for (let i = 0; i < count && fragCount < MAX_FRAGMENTS; i++) {
    const angle = (2 * Math.PI * i) / count;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    // Stop the fragment at the first wall, standing in for the bounce the engine gave it. The
    // Grenade mask is world plus physics props and ignores players, which is what a thrown grenade
    // collides with on the way out.
    let fx = x + dx * settle;
    let fy = y + dy * settle;
    if (settle > 0) {
      const wall = Trace.line(from, new Vector(fx, fy, z + 8), { mask: TraceMask.Grenade });
      if (wall.didHit) {
        // Pull back off the surface so the fragment sits in the room, not inside the brush.
        fx = wall.endPos.x - dx * 8;
        fy = wall.endPos.y - dy * 8;
      }
    }

    fragX[fragCount] = fx;
    fragY[fragCount] = fy;
    fragZ[fragCount] = z;
    fragFuse[fragCount] = FRAG_FUSE + i * FRAG_STAGGER;
    fragCount++;
  }
}

// ── the shared tick ──────────────────────────────────────────────────────────
/**
 * Advance the world effects owned by this module. Driven by the plugin's single frame handler,
 * alongside `tickEffects`.
 */
export function tickWeaponFx(dt: number): void {
  if (clouds.length > 0) tickClouds(dt);
  if (fragCount > 0) tickFragments(dt);
}

/** Advance every live poison cloud. */
function tickClouds(dt: number): void {
  const interval = Math.max(0.05, n("css_ttt_shop_poisonsmoke_poison_tick_interval") / 1000);
  const perTick = n("css_ttt_shop_poisonsmoke_poison_damage_per_tick");
  const sound = s("css_ttt_shop_poisonsmoke_poison_sound");

  for (let i = clouds.length - 1; i >= 0; i--) {
    const cl = clouds[i]!;
    cl.life -= dt;
    // The C# stopped when the projectile went invalid or the shared pool ran dry.
    if (cl.life <= 0 || cl.budget <= 0) {
      clouds.splice(i, 1);
      continue;
    }
    cl.timer += dt;
    if (cl.timer < interval) continue;
    cl.timer = 0;

    const active = reg.activeSlots();
    for (let j = 0; j < active.length; j++) {
      const slot = active[j]!;
      if (!reg.isAlive(slot)) continue;
      // The C# filtered on `role is InnocentRole or DetectiveRole`, which also excludes anyone with
      // no role at all — not just Traitors.
      const role = reg.roleOf(slot);
      if (role !== RoleId.Innocent && role !== RoleId.Detective) continue;

      const pawn = pawnOf(slot);
      if (pawn === null) continue;
      const o = pawn.origin;
      if (o === null) continue;
      // Re-measured against the CLOUD every tick, never against where the victim was when it popped.
      const dx = o.x - cl.x;
      const dy = o.y - cl.y;
      const dz = o.z - cl.z;
      if (dx * dx + dy * dy + dz * dz > cl.radiusSq) continue;

      // The pool is re-checked per victim INSIDE the loop, exactly as the C# does — so a tick that
      // empties it can still overshoot by up to (victims - 1) * perTick.
      if (cl.budget <= 0) continue;

      const hp = pawn.health ?? 0;
      if (hp - perTick <= 0) {
        // A lethal tick kills outright and, in the C#, does NOT charge the shared pool.
        setHealth(slot, 0);
        continue;
      }
      setHealth(slot, hp - perTick);
      cl.budget -= perTick;
      if (sound !== "") Sound.emit(sound, { recipients: [slot] });
    }
  }
}

/** Count fuses down and detonate the fragments that reach zero. */
function tickFragments(dt: number): void {
  const active = reg.activeSlots();
  for (let i = fragCount - 1; i >= 0; i--) {
    const fuse = fragFuse[i]! - dt;
    if (fuse > 0) {
      fragFuse[i] = fuse;
      continue;
    }
    detonateFragment(fragX[i]!, fragY[i]!, fragZ[i]!, active);
    // Swap-remove: fragment order carries no meaning and this keeps the drain allocation-free.
    fragCount--;
    fragX[i] = fragX[fragCount]!;
    fragY[i] = fragY[fragCount]!;
    fragZ[i] = fragZ[fragCount]!;
    fragFuse[i] = fragFuse[fragCount]!;
  }
}

/** One fragment goes off: falloff damage to everyone it can actually see. */
function detonateFragment(fx: number, fy: number, fz: number, active: readonly number[]): void {
  const from = new Vector(fx, fy, fz + 8);

  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    const dx = o.x - fx;
    const dy = o.y - fy;
    const dz = o.z - fz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > FRAG_RADIUS) continue;
    const damage = Math.round(FRAG_DAMAGE * (1 - dist / FRAG_RADIUS));
    if (damage <= 0) continue;

    // Cover has to work — this is the whole point of simulating fragments rather than applying a
    // radius sweep. Chest height, world geometry only, so a teammate standing in the way does not
    // shield you the way a wall does.
    const los = Trace.line(from, new Vector(o.x, o.y, o.z + 36), { mask: TraceMask.WorldOnly });
    // A trace that STARTS in solid tells us nothing (the fragment settled half inside a brush), so
    // treat it as clear rather than silently deleting the fragment for everyone.
    if (los.didHit && !los.startSolid) continue;

    setHealth(slot, (pawn.health ?? 0) - damage);
  }
}
