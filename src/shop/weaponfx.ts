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
import { createEntity, Entity, type EntityRef } from "@s2script/sdk/entity";
import { refOwnsIndex } from "../core/index-identity";
import { Transmit } from "@s2script/sdk/transmit";
import { after } from "@s2script/sdk/timers";
import { Sound, type PrecacheContext } from "@s2script/sdk/sound";
import { Vector } from "@s2script/sdk/math";
import { Trace, TraceMask } from "@s2script/sdk/trace";
import { ChatColors, wrapEntity } from "@s2script/cs2";
import { roleModel } from "../cs2/icons";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { cfg, n, s } from "../core/cvars";
import { msg, msgFor } from "../core/msgs";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setHealth, teamOf, tell } from "../cs2/pawn";
import { hudLine, HUD_FONT_BIG, HUD_FONT_MID, HUD_FONT_SMALL, setCenterHud } from "../cs2/hud";
import { Engine } from "@s2script/sdk/unsafe";
import { killWithGadget } from "../cs2/combat";
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
 * Keyed on `slot:body.id` so a recycled ragdoll index cannot inherit or skip another corpse's
 * scan window. The C# used `player.Id + "." + body.Id` for the same reason.
 */
const lastDnaRead = new Map<string, number>();

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
  Server.setCvar("mp_c4timer", String(n("sm_ttt_shop_c4_fuse_time")));
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
      const awpDef = n("sm_ttt_shop_silentawp_index");
      if (def !== null && def !== awpDef) return;

      silentShots[shooter] = silentShots[shooter]! - 1;
      return HookResult.Handled;
    });
  } catch {
    console.log("[ttt] WARN: fire-bullets message unavailable: Silent AWP and Suppressed are inert");
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
  if (left - 1 === 0) tell(slot, msgFor(slot, "SHOP_ITEM_POISON_OUT"));
}

// ── poison smoke clouds ──────────────────────────────────────────────────────
/**
 * A live poison cloud. Damage is re-targeted from the CLOUD's position every tick, so walking out
 * saves you and walking in catches you, and the budget is shared by everyone the cloud ever hits.
 */
interface Cloud {
  /**
   * Who threw it. The damage is a direct health write, which reaches the engine with no attacker,
   * so a lethal tick hands the thrower to `markGadgetKill` — the C# dispatched its own
   * `PlayerDeathEvent(...).WithKiller(effect.Attacker).WithWeapon("[Poison Smoke]")` for the same
   * reason.
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
  /**
   * Live ref for {@link entity}, or null when `findByClass` could not bind one. A recycled
   * projectile index is detected by `refOwnsIndex` failing — the id alone is not an identity.
   */
  ref: EntityRef | null;
}

/**
 * How long a cloud keeps poisoning, in seconds, when we could not bind a projectile ref.
 *
 * The C# ticked for as long as `effect.Projectile.IsValid`. At detonate we resolve the projectile
 * through `findByClass` + index and keep the `EntityRef`; a bound cloud then dies when that ref
 * goes invalid or the index is reused. Unbound clouds still run this lifetime, cut short by
 * `smokegrenade_expired` when that event is wired through.
 */
const SMOKE_LIFETIME = 18;
/** Designer name of the in-world smoke projectile the detonate/expire events name by index. */
const SMOKE_PROJECTILE = "smokegrenade_projectile";

const clouds: Cloud[] = [];

/** Reset every per-round charge and every live world effect. */
export function resetWeaponFx(): void {
  silentShots.fill(0);
  poisonShots.fill(0);
  poisonSmoke.fill(0);
  clusterCharge.fill(0);
  lastDnaRead.clear();
  resetDnaTracking();
  clouds.length = 0;
  destroyLiveFragments();
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

  const key = `${slot}:${body.id}`;
  const now = Server.gameTime;
  const last = lastDnaRead.get(key);
  if (last !== undefined && now - last < DNA_COOLDOWN) return;
  lastDnaRead.set(key, now);

  const roleColour = rolePrefix(body.ownerRole);
  if (now - body.timeOfDeath > n("sm_ttt_shop_dna_decay_time")) {
    tell(slot, msgFor(slot, "SHOP_ITEM_DNA_EXPIRED", roleColour, body.ownerName));
    return;
  }
  // Order matters and follows the C#: a wiped trace (`body.Killer == null`) is reported before the
  // suicide case, so Gloves still read as "no DNA" rather than "they killed themselves".
  if (body.dnaSuppressed || body.killer < 0) {
    const why = NO_DNA[(Math.random() * NO_DNA.length) | 0]!;
    tell(slot, msgFor(slot, "SHOP_ITEM_DNA_SCANNED_OTHER", roleColour, body.ownerName, why));
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
  // The killer is NOT named here. The scan yields a trace; identifying whoever left it is the work,
  // and handing over the name for free is what made the item trivialise the round.
  tell(slot, msgFor(slot, "SHOP_ITEM_DNA_TRACE", roleColour, body.ownerName));
  dnaTarget[slot] = body.killer;
  dnaExpiry[slot] = body.timeOfDeath + n("sm_ttt_shop_dna_decay_time");
  dnaProgress[slot] = 0;
  dnaIdentified[slot] = 0;
}

// ── DNA tracking ─────────────────────────────────────────────────────────────
/**
 * A live DNA lead: who left the trace, when it goes cold, and how close the Detective is to putting
 * a name to them.
 *
 * The scan no longer names the killer. It hands over a trace, and the Detective earns the name by
 * getting EYES on the person — line of sight, inside a range, held long enough. That keeps the item
 * an investigation aid rather than an instant answer.
 *
 * Deliberately NOT an entity. A beam or a through-wall glow needs a networked entity carrying a
 * per-viewer transmit rule, which is the outstanding suspect for the client-side network fatals; all
 * of this is per-client HUD events and traces, and adds nothing to the snapshot.
 */
const dnaTarget = new Int32Array(MAX_SLOTS).fill(-1);
const dnaExpiry = new Float32Array(MAX_SLOTS);
/** Seconds of clean line of sight accumulated on the target. */
const dnaProgress = new Float32Array(MAX_SLOTS);
/** 1 once the name has been revealed — the lead stops progressing and just tracks. */
const dnaIdentified = new Uint8Array(MAX_SLOTS);
/** Server time the lock happened, so the banner can hold briefly before the readout takes over. */
const dnaLockedAt = new Float32Array(MAX_SLOTS);

/** How close the Detective must be for the trace to make progress. */
const DNA_ID_RANGE = 900;
/** Seconds of unbroken line of sight needed to put a name to the trace. */
const DNA_ID_SECONDS = 4;
/** Seconds the "identified" banner holds the screen before settling into the tracking readout. */
const DNA_LOCK_BANNER = 3;
/** Cue for the moment a trace resolves to a person. */
const SND_DNA_LOCK = "c4.disarmfinish";
/**
 * Arrow glyphs, hard left to hard right.
 *
 * NOT `<<` / `<`. The centre-screen HUD renders its token as HTML, so a literal `<` opens a tag and
 * the parser eats the glyph — the left arrows silently rendered as nothing while `>` and `>>` came
 * through fine, so the readout only ever appeared to say "straight" or "right". Any glyph used here
 * must be HTML-safe.
 */
const DNA_ARROWS = ["\u25C0\u25C0", "\u25C0", "\u25B2", "\u25B6", "\u25B6\u25B6"];

/**
 * The through-wall marker on an identified killer: a relay bone-merged to their pawn and a glow model
 * merged onto the relay, both invisible except for the outline, both transmitted ONLY to the
 * Detective who identified them.
 *
 * Two entities rather than one, and `kRenderTransAlpha` rather than `kRenderNone`, because that is
 * what the Traitor glow proved works: the glow pass does not render correctly on the entity doing the
 * bone-merge, and kRenderNone drops the entity from rendering altogether — taking the glow with it.
 */
const dnaGlowRelay: (EntityRef | null)[] = new Array<EntityRef | null>(MAX_SLOTS).fill(null);
const dnaGlowModel: (EntityRef | null)[] = new Array<EntityRef | null>(MAX_SLOTS).fill(null);

/** `RenderMode_t::kRenderTransAlpha`. NOT kRenderNone — see above. */
const DNA_GLOW_RENDER = 1;

/** Pack RGBA into the uint32 `m_glowColorOverride` hold (red in the low byte). */
function packGlow(r: number, g: number, b: number): number {
  return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | (255 << 24)) >>> 0;
}

/** Tear down `slot`'s marker. CHILD FIRST: the model is merged onto the relay, so the relay is its
 *  parent, and destroying a parent while clients still hold the child is what produces
 *  `CopyExistingEntity: missing client entity`. */
function hideRef(ent: EntityRef | null): void {
  if (ent !== null && ent.isValid()) Transmit.setVisibleTo(ent, []);
}

function clearDnaGlow(slot: number): void {
  const model = dnaGlowModel[slot];
  if (model !== null) {
    // Hide first — resetting transmit then Kill broadcasts a dying hidden entity.
    hideRef(model);
    model.acceptInput("Kill");
    dnaGlowModel[slot] = null;
  }
  const relay = dnaGlowRelay[slot];
  if (relay !== null) {
    hideRef(relay);
    relay.acceptInput("Kill");
    dnaGlowRelay[slot] = null;
  }
}

/** Re-hide every DNA marker. Call before teardown `Kill` on a hot reload. */
export function hideWeaponFx(): void {
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    hideRef(dnaGlowModel[slot]);
    hideRef(dnaGlowRelay[slot]);
  }
}

/**
 * Build the marker on `target`, seen only by `viewer`.
 *
 * FAIL-CLOSED: if the transmit rule is refused the pair is destroyed, because a marker everyone can
 * see hands the whole server the killer's identity — the exact thing the Detective had to work for.
 */
function spawnDnaGlow(viewer: number, target: number): void {
  clearDnaGlow(viewer);
  // See `sm_ttt_dna_glow`: this pair is the standing suspect for the client-side
  // `CopyExistingEntity` fatals, and it is off by default until that is settled.
  if (!cfg.dnaGlow) return;
  const pawn = pawnOf(target);
  if (pawn === null || !pawn.isValid) return;
  const model = roleModel(reg.roleOf(target));

  const relay = createEntity("prop_dynamic", { model, targetname: `ttt_dna_relay_${viewer}` });
  if (relay === null) return;
  const glow = createEntity("prop_dynamic", { model, targetname: `ttt_dna_glow_${viewer}` });
  if (glow === null) {
    relay.acceptInput("Kill");
    return;
  }

  const relayFields = wrapEntity("CBaseModelEntity", relay);
  const glowFields = wrapEntity("CBaseModelEntity", glow);
  relayFields.renderMode = DNA_GLOW_RENDER;
  glowFields.renderMode = DNA_GLOW_RENDER;

  const g = glowFields.glow;
  g.glowColorOverride = packGlow(80, 255, 120);
  g.glowType = 3;   // through walls
  g.glowTeam = -1;
  g.glowRange = 5000;
  g.glowRangeMin = 0;
  g.glowing = true;

  relay.acceptInput("FollowEntity", "!activator", pawn.ref, relay);
  glow.acceptInput("FollowEntity", "!activator", relay, glow);

  const only = [viewer];
  if (!Transmit.setVisibleTo(relay, only) || !Transmit.setVisibleTo(glow, only)) {
    // Removed while still filtered — see the note in icons.ts `removeIcons`: resetting first
    // broadcasts a dying hidden entity to every client for one snapshot.
    glow.acceptInput("Kill");
    // Removed while still filtered — see the note in icons.ts `removeIcons`: resetting first
    // broadcasts a dying hidden entity to every client for one snapshot.
    relay.acceptInput("Kill");
    return;
  }
  dnaGlowRelay[viewer] = relay;
  dnaGlowModel[viewer] = glow;
}

/**
 * Repaint the marker: GREEN while the trace is fresh, through amber, to RED as it decays, pulsing
 * throughout so it reads as a live signal rather than a static outline.
 */
function paintDnaGlow(viewer: number, fracLeft: number, now: number): void {
  const glow = dnaGlowModel[viewer];
  if (glow === null || !glow.isValid()) return;
  // ~1.4 Hz, never fully dark: the pulse is a brightness ramp, not a blink, so the target stays
  // trackable at the bottom of the cycle.
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(now * 4.4));
  const f = Math.max(0, Math.min(1, fracLeft));
  const r = Math.round((255 - 175 * f) * pulse);
  const g = Math.round((80 + 175 * f) * pulse);
  const b = Math.round(90 * f * pulse);
  wrapEntity("CBaseModelEntity", glow).glow.glowColorOverride = packGlow(r, g, b);
}

/** Clear every live DNA lead (round boundary). */
export function resetDnaTracking(): void {
  for (let slot = 0; slot < MAX_SLOTS; slot++) clearDnaGlow(slot);
  dnaTarget.fill(-1);
  dnaExpiry.fill(0);
  dnaProgress.fill(0);
  dnaIdentified.fill(0);
  dnaLockedAt.fill(0);
}

/**
 * Advance every Detective's DNA lead and paint their readout.
 *
 * Driven from the shared frame handler, before the HUD drain. One comparison per slot while nobody is
 * tracking, which is most of a round.
 */
export function tickDnaTracker(dt: number): void {
  const now = Server.gameTime;
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const target = dnaTarget[slot]!;
    if (target < 0) continue;

    const left = dnaExpiry[slot]! - now;
    // Expired, target dead, or the scanner died: the lead is over and the HUD line goes with it.
    if (left <= 0 || !reg.isAlive(slot) || !reg.isAlive(target)) {
      dnaTarget[slot] = -1;
      clearDnaGlow(slot);
      setCenterHud(slot, "");
      continue;
    }
    if (dnaIdentified[slot] === 1) {
      paintDnaGlow(slot, left / Math.max(1, n("sm_ttt_shop_dna_decay_time")), now);
    }

    const me = pawnOf(slot);
    const them = pawnOf(target);
    const o = me === null ? null : me.origin;
    const ang = me === null ? null : me.eyeAngles;
    const to = them === null ? null : them.origin;
    if (o === null || ang === null || to === null) continue;

    const dx = to.x - o.x;
    const dy = to.y - o.y;
    const dz = to.z - o.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Progress needs them close AND actually visible. World geometry only, so a team-mate walking
    // through the sightline does not reset the read; a wall does. FAIL-CLOSED: a trace that starts
    // in solid tells us nothing and counts as blocked.
    let visible = false;
    if (dist <= DNA_ID_RANGE) {
      const eye = new Vector(o.x, o.y, o.z + 64);
      const chest = new Vector(to.x, to.y, to.z + 48);
      const los = Trace.line(eye, chest, { mask: TraceMask.WorldOnly });
      visible = !los.didHit && !los.startSolid;
    }

    if (dnaIdentified[slot] === 0) {
      // Losing sight DECAYS progress rather than resetting it: a target ducking behind cover for a
      // moment should cost you, not send you back to the start.
      dnaProgress[slot] = Math.max(0, dnaProgress[slot]! + (visible ? dt : -dt * 0.5));
      if (dnaProgress[slot]! >= DNA_ID_SECONDS) {
        dnaIdentified[slot] = 1;
        dnaLockedAt[slot] = now;
        // The lock is the payoff, so it is announced three ways: chat (permanent record), a banner
        // that owns the screen for a moment, and a cue — a Detective mid-chase is not reading chat.
        tell(slot, msgFor(slot, "DNA_TRACK_IDENTIFIED", reg.nameOf(target)));
        Sound.emit(SND_DNA_LOCK, { recipients: [slot] });
        // The reward for the work: from here the killer is visible through walls, to this Detective
        // only, until the trace goes cold.
        spawnDnaGlow(slot, target);
      }
    }

    // Signed bearing, -180..180. POSITIVE is to the LEFT: Source yaw increases counter-clockwise, so
    // a target at +90 relative is off the player's left shoulder. Getting this backwards is what made
    // the arrows point the wrong way.
    const deg = 180 / Math.PI;
    let bearing = Math.atan2(dy, dx) * deg - ang.y;
    bearing = ((((bearing + 180) % 360) + 360) % 360) - 180;
    const arrow =
      bearing > 60 ? DNA_ARROWS[0]
      : bearing > 15 ? DNA_ARROWS[1]
      : bearing >= -15 ? DNA_ARROWS[2]
      : bearing >= -60 ? DNA_ARROWS[3]
      : DNA_ARROWS[4];

    const secs = Math.ceil(left);
    const clockColour = secs <= 10 ? "#ff6666" : "#cccccc";

    // The bearing and range are shown THROUGHOUT, not just after the lock. Without a through-wall
    // glow they are the only thing helping a Detective close the gap, and they are needed most while
    // the killer is still a stranger — showing them only after identification had it backwards.
    const range = `${arrow!}  ${String(Math.round(dist / 12))}m`;

    if (dnaIdentified[slot] === 1) {
      // Hold the reveal on screen briefly, then settle into the ongoing readout.
      const banner = now - dnaLockedAt[slot]! < DNA_LOCK_BANNER;
      setCenterHud(
        slot,
        banner
          ? hudLine(msgFor(slot, "DNA_TRACK_IDENTIFIED", reg.nameOf(target)), "#66ff88", HUD_FONT_BIG) +
              `<br>${hudLine(range, "#aaaaaa", HUD_FONT_MID)}`
          : hudLine(`${range}  ${reg.nameOf(target)}`, "#66ccff", HUD_FONT_BIG) +
              `<br>${hudLine(`${String(secs)}s`, clockColour, HUD_FONT_SMALL)}`,
      );
      continue;
    }

    // Un-identified: how the read is going and which way to go, never who it is. The stage text is
    // the feedback loop — it tells the Detective that closing in and holding sight is what advances
    // it, rather than leaving them to guess why nothing is happening.
    const frac = dnaProgress[slot]! / DNA_ID_SECONDS;
    const stage =
      !visible ? msgFor(slot, "DNA_TRACK_SEARCHING")
      : frac < 0.4 ? msgFor(slot, "DNA_TRACK_ATTEMPTING")
      : frac < 0.75 ? msgFor(slot, "DNA_TRACK_ALMOST")
      : msgFor(slot, "DNA_TRACK_IDENTIFYING");
    setCenterHud(
      slot,
      hudLine(range, visible ? "#ffcc00" : "#888888", HUD_FONT_BIG) +
        `<br>${hudLine(stage, visible ? "#ffcc00" : "#888888", HUD_FONT_MID)}` +
        `<br>${hudLine(`${String(Math.round(frac * 100))}%`, "#aaaaaa", HUD_FONT_SMALL)}` +
        ` ${hudLine(`${String(secs)}s`, clockColour, HUD_FONT_SMALL)}`,
    );
  }
}

// ── grenades ─────────────────────────────────────────────────────────────────
/**
 * A smoke grenade detonated. If the thrower armed Poison Smoke, the cloud becomes a live world
 * effect: anyone inside it who is an Innocent or a Detective takes a tick of poison, drawn from one
 * pool shared by the whole cloud.
 *
 * `entityId` is the projectile index from the event. We bind a live `EntityRef` at detonate so
 * a later expire/tick can tell this smoke from whatever reused the number. The cloud still
 * self-expires on lifetime when no ref could be bound.
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

  const radius = n("sm_ttt_shop_poisonsmoke_radius");
  clouds.push({
    owner: thrower,
    x,
    y,
    z,
    radiusSq: radius * radius,
    budget: n("sm_ttt_shop_poisonsmoke_poison_total_damage"),
    timer: 0,
    life: SMOKE_LIFETIME,
    entity: entityId,
    ref: bindSmokeRef(entityId),
  });
}

/** Resolve the detonating projectile by class + index. Null when the SDK cannot name it. */
function bindSmokeRef(entityId: number): EntityRef | null {
  if (entityId < 0) return null;
  const found = Entity.findByClass(SMOKE_PROJECTILE);
  for (let i = 0; i < found.length; i++) {
    if (found[i]!.index === entityId) return found[i]!;
  }
  return null;
}

/**
 * True when this cloud should keep ticking.
 *
 * A bound ref that is dead or now names a different index means the projectile is gone or the
 * number was recycled — drop the cloud. Unbound clouds fall through to lifetime / expire.
 */
function cloudStillBound(cl: Cloud): boolean {
  if (cl.ref === null) return true;
  return refOwnsIndex(cl.ref, cl.entity);
}

/** The smoke cloud for `entityId` dispersed — its poison goes with it. */
export function onSmokeExpired(entityId: number): void {
  if (entityId < 0) return;
  for (let i = clouds.length - 1; i >= 0; i--) {
    const cl = clouds[i]!;
    if (cl.entity !== entityId) continue;
    // A live ref that no longer owns this index is a different smoke wearing a recycled number.
    if (cl.ref !== null && cl.ref.isValid() && cl.ref.index !== entityId) continue;
    clouds.splice(i, 1);
  }
}

/**
 * An HE grenade detonated. If the thrower armed a Cluster Grenade, scatter real HE projectiles around
 * the epicentre in a ring and let the engine fly, bounce, explode and score them — the same thing the
 * C# `ClusterGrenadeListener` did.
 *
 * ENTITY CREATION ALONE CANNOT DO THIS, which is worth recording so it is not retried. `createEntity`
 * is `UTIL_CreateEntityByName`, so `hegrenade_projectile` IS constructible and the result flies and
 * bounces correctly — but nothing makes it go off. Verified live, in order: `m_flDetonateTime` (a
 * deadline nothing checks), `m_bIsLive` (the armed flag), `m_nNextThinkTick` (the schedule — a
 * scheduled think with no think FUNCTION assigned runs nothing), and a `Detonate` input (not
 * accepted). Detonation is think-driven and the think function pointer is not schema state, so no
 * field write reaches it.
 *
 * `CHEGrenadeProjectile::Create` assigns it, along with the thrower, team and weapon id — which is
 * why kills credit correctly here and did not when the fragments were simulated. It is declared in
 * this plugin's own gamedata and reached through `Engine.call`, so the CS2 specifics stay in the
 * plugin.
 */
/** WEAPON_HEGRENADE — the weapon id `CHEGrenadeProjectile::Create` records on the projectile. */
const WEAPON_ID_HEGRENADE = 44;

/**
 * The engine factory, resolved ONCE. Null when the descriptor failed a load-time gate — a signature
 * miss, or `@edgegamers/ttt` not being on the operator's `engine:calls` allow-list.
 */
const createHeGrenade = Engine.call("createHeGrenade");
if (createHeGrenade === null) {
  console.log(`[ttt] WARN: cluster grenade unavailable — ${Engine.status("createHeGrenade")}`);
}

/**
 * Cluster fragments still in the air, so they can be destroyed at a round boundary.
 *
 * A LIVE GRENADE MUST NEVER CROSS A ROUND BOUNDARY. The simulated fragments this replaced were reset
 * here for the same reason ("fragments must never cook off into the next round"); real projectiles
 * need it more, not less. A cluster that wins the round leaves up to eight engine-owned grenades
 * mid-flight holding a handle to a thrower pawn that the round restart is about to destroy, and they
 * are networked entities — a client asked to copy one whose thrower has gone can hard-error out of
 * the game ("Copy Entity ..."), which is exactly what was seen when a cluster took the last kills and
 * the next round began.
 */
const liveFragments: EntityRef[] = [];

/** Destroy every fragment still in the world. */
function destroyLiveFragments(): void {
  for (let i = 0; i < liveFragments.length; i++) {
    const nade = liveFragments[i]!;
    if (nade.isValid()) nade.acceptInput("Kill");
  }
  liveFragments.length = 0;
}

export function onHeDetonate(thrower: number, x: number, y: number, z: number): void {
  if (thrower < 0 || clusterCharge[thrower] !== 1 || !inProgress()) return;
  clusterCharge[thrower] = 0;
  if (createHeGrenade === null) return;

  const pawn = pawnOf(thrower);
  if (pawn === null || !pawn.isValid) return;

  const count = n("sm_ttt_shop_clustergrenade_count");
  const throwForce = n("sm_ttt_shop_clustergrenade_throw_force");
  const upForce = n("sm_ttt_shop_clustergrenade_up_force");
  const team = teamOf(thrower);

  // Fired in a ring, exactly as the C# `ClusterGrenadeListener` did: a circular velocity around the
  // epicentre, and the engine flies, bounces and detonates each one on its own fuse.
  //
  // Spawned 16u up so a fragment does not start inside the floor the parent grenade was resting on.
  const origin = { x, y, z: z + 16 };
  const zeroAngles = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    const velocity = { x: Math.cos(a) * throwForce, y: Math.sin(a) * throwForce, z: upForce };
    const nade = createHeGrenade(
      origin,
      zeroAngles,
      velocity,
      zeroAngles,
      pawn.ref,
      WEAPON_ID_HEGRENADE,
      team,
    );
    // Tracked so the round boundary can destroy anything still airborne — see `liveFragments`.
    // A detonated grenade removes itself, and `isValid()` covers that; the list is cleared each round
    // either way, so it cannot grow without bound.
    if (nade !== null) liveFragments.push(nade);
  }
}

// ── the shared tick ──────────────────────────────────────────────────────────
/**
 * Advance the world effects owned by this module. Driven by the plugin's single frame handler,
 * alongside `tickEffects`.
 */
export function tickWeaponFx(dt: number): void {
  if (clouds.length > 0) tickClouds(dt);
}

/** Advance every live poison cloud. */
function tickClouds(dt: number): void {
  const interval = Math.max(0.05, n("sm_ttt_shop_poisonsmoke_poison_tick_interval") / 1000);
  const perTick = n("sm_ttt_shop_poisonsmoke_poison_damage_per_tick");
  const sound = s("sm_ttt_shop_poisonsmoke_poison_sound");

  for (let i = clouds.length - 1; i >= 0; i--) {
    const cl = clouds[i]!;
    if (!cloudStillBound(cl)) {
      clouds.splice(i, 1);
      continue;
    }
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
        //
        // `suppressBody` is the Poison Smoke rule and only Poison Smoke's: `OnRagdollSpawn` cancels
        // the corpse of anyone in `killedWithPoison`, so a smoke victim leaves nothing to find,
        // identify or scan. The thrower is recorded here rather than when the cloud popped, because
        // the C# adds to `killedWithPoison` on the killing tick, not on entry to the cloud.
        killWithGadget(slot, cl.owner, "[Poison Smoke]", true);
        continue;
      }
      setHealth(slot, hp - perTick);
      cl.budget -= perTick;
      if (sound !== "") Sound.emit(sound, { recipients: [slot] });
    }
  }
}

