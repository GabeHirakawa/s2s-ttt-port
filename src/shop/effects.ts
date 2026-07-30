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
import { Sound, type PrecacheContext } from "@s2script/sdk/sound";
import { Beam, Fade, wrapEntity, type BeamHandle } from "@s2script/cs2";
import { hudLine, HUD_FONT_BIG, HUD_FONT_SMALL, setCenterHud } from "../cs2/hud";
import { Server } from "@s2script/sdk/server";
import { nextFrame } from "@s2script/sdk/timers";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { b, n, s } from "../core/cvars";
import { msg, msgFor } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setHealth, tell } from "../cs2/pawn";
import { colorCorpse, ROLE_COLORS, setEntityColor, setPawnAlpha, type Rgb } from "../cs2/color";
import { restrictToTraitors } from "../cs2/icons";
import {
  give, removeByDef, resolveWeapon, TASER_DEF, weaponClass, KNIVES, PISTOLS, RIFLES, type HeldWeapon,
} from "../cs2/inventory";
import { allBodies, type Body } from "../cs2/bodies";
// Closes a module cycle (`combat` -> `handlers` -> `effects`). Safe: every edge is a hoisted
// function called at event time, and nothing in this file is read while a module is still
// evaluating.
import { killWithGadget, markGadgetKill } from "../cs2/combat";
import { addBalance } from "./shop";
import { poisonShotsLeft } from "./weaponfx";
import { suppressKarmaOnce } from "../karma/karma";
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
/** Active compass mode. */
const compass = new Uint8Array(MAX_SLOTS);

// ── poison applied to victims ────────────────────────────────────────────────
/** Poison damage still owed to each slot. */
const poisonRemaining = new Int32Array(MAX_SLOTS);
/** Seconds until the next poison tick. */
const poisonTimer = new Float32Array(MAX_SLOTS);
/**
 * Who applied the poison on this slot, and whether it came from a smoke rather than a shot.
 *
 * The source is stored when the poison lands but only READ on the lethal tick — see `tickPoison` —
 * exactly as `killedWithPoison[player.Id] = shooter` was written there and nowhere else.
 *
 * The kind matters twice. Only the Shots path washes the victim's screen (`PoisonShotsListener`
 * called `ColorScreen`; `PoisonSmokeListener` ticked its damage without one), and only the Smoke
 * path leaves no corpse at all (`PoisonSmokeListener.OnRagdollSpawn` cancels body creation).
 */
const poisonSource = new Int32Array(MAX_SLOTS).fill(-1);
const poisonFromSmoke = new Uint8Array(MAX_SLOTS);

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
  /**
   * Server time the wire was placed — the C# `TripwireInstance.placedAt`. Read by the karma
   * forgiveness window: an old trap that kills a fellow Traitor is not the owner's fault.
   */
  placedAt: number;
  beam: BeamHandle | null;
  /** The two anchor props, one at each end of the wire. Either may be null if creation failed. */
  propA: EntityRef | null;
  propB: EntityRef | null;
  /** Traitor-only glow twins overlaying the anchors. Null when not created or refused. */
  glowA: EntityRef | null;
  glowB: EntityRef | null;
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

/**
 * Station and tripwire models — the C#'s own choices (`StationItem`, `TripwireItem`).
 *
 * These need PRECACHING to render, and precaching them only started working once the runtime added
 * the game session manifest. Before that both spawned as the pink-and-black ERROR box: they are
 * present in `pak01_dir.vpk`, `PrecacheContext.add` returned true, and the engine still refused them
 * at spawn with "requested but is not in the system (Missing from a manifest?)". The adds were going
 * to the wrong manifest — the one `CGameRulesGameSystem::OnPrecacheResource` hands out, which does not
 * govern residency. `add` returning true means only that the string was accepted; it returned true for
 * a path with no file behind it too, so its result carries no information.
 *
 * Both stations share one model, as in the C# (`StationItem` is the base for heal and hurt alike).
 */
const STATION_MODEL = "models/props/cs_office/microwave.vmdl";
const TRIPWIRE_MODEL = "models/generic/conveyor_control_panel_01/conveyor_button_02.vmdl";

/**
 * Register this module's models for the current map. Call from `ctx.server.onPrecache`.
 *
 * The return value is checked rather than discarded: `add` reports whether the engine ACCEPTED the
 * resource into the session manifest, and a refused add is the difference between a model and a
 * pink-and-black error box. The engine's own complaint ("requested but is not in the system, missing
 * from a manifest?") arrives much later, at spawn time, with nothing tying it back to here.
 */
export function precacheEffectModels(pc: PrecacheContext): void {
  const models = [STATION_MODEL, TRIPWIRE_MODEL];
  for (let i = 0; i < models.length; i++) {
    const path = models[i]!;
    if (!pc.add(path)) console.log(`[ttt] WARN: precache refused ${path}`);
  }
}

/**
 * One tripwire anchor prop, laid flat against the surface at `(x, y, z)` with normal `(nx, ny, nz)`.
 *
 * ORIENTED BY THE SURFACE NORMAL, as the C# does (`originTrace.Normal.toAngle()`). Spawning it with
 * no angles left the panel lying at whatever default rotation the model has — sideways on a wall, and
 * visibly not attached to it.
 *
 * Nudged 1 unit out along the normal as well: placed exactly on the traced surface, half the prop is
 * inside the brush.
 *
 * The model is a SPAWN KEYVALUE. `setModel` after spawn leaves a `prop_dynamic at (0,0,0) has no
 * model name!` — the prop spawns broken and the later call is too late — and `setModel` before spawn
 * trips the `SetupModel()` staging assertion. Same trap as the corpses and the glow props.
 */
function spawnTripwireProp(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  name: string,
): EntityRef | null {
  const prop = createEntity("prop_dynamic", { model: TRIPWIRE_MODEL, targetname: name });
  if (prop === null) return null;

  // Direction -> Source angles: yaw about Z, pitch from the vertical component. Roll is 0 — a normal
  // says nothing about spin around itself, and the C# leaves it at zero too.
  const deg = 180 / Math.PI;
  const yaw = Math.atan2(ny, nx) * deg;
  const pitch = Math.atan2(-nz, Math.sqrt(nx * nx + ny * ny)) * deg;
  prop.teleport([x + nx, y + ny, z + nz], [pitch, yaw, 0], null);
  return prop;
}

/**
 * `RenderMode_t::kRenderTransAlpha` — the value that hides a prop while still drawing its glow.
 *
 * NOT `kRenderNone`. That is the semantically obvious choice and it is wrong: at kRenderNone the
 * engine drops the entity from rendering altogether and takes the glow pass with it, so every glow
 * field reads back correct and nothing appears. Learned the hard way on the Traitor glow.
 */
const GLOW_RENDER_TRANS_ALPHA = 1;

/**
 * A Traitor-only glow twin sitting on a tripwire anchor.
 *
 * The anchor itself must NOT glow. Glow has no per-viewer form, so a glowing anchor glows for
 * everyone and hands Innocents the wire's location; and hiding the anchor from Innocents is worse
 * still, since finding and defusing a wire is their counter-play. So the real anchor stays visible to
 * all and un-glowing, and a second copy — invisible except for its outline, and transmitted only to
 * Traitors — is laid over it.
 *
 * No bone-merge relay here, unlike the player glow: a tripwire anchor does not animate, so the twin
 * can simply be parked at the same place.
 */
function spawnTripwireGlow(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  name: string,
): EntityRef | null {
  const c = ROLE_COLORS[RoleId.Traitor];
  if (c === undefined) return null;
  const prop = createEntity("prop_dynamic", { model: TRIPWIRE_MODEL, targetname: name });
  if (prop === null) return null;

  const deg = 180 / Math.PI;
  const yaw = Math.atan2(ny, nx) * deg;
  const pitch = Math.atan2(-nz, Math.sqrt(nx * nx + ny * ny)) * deg;
  prop.teleport([x + nx, y + ny, z + nz], [pitch, yaw, 0], null);

  const f = wrapEntity("CBaseModelEntity", prop);
  f.renderMode = GLOW_RENDER_TRANS_ALPHA;
  const g = f.glow;
  g.glowColorOverride = ((c.r & 0xff) | ((c.g & 0xff) << 8) | ((c.b & 0xff) << 16) | (255 << 24)) >>> 0;
  g.glowType = 3;
  g.glowTeam = -1;
  g.glowRange = 5000;
  g.glowRangeMin = 0;
  // Written LAST: the others are read when the glow switches on, so flipping this first can latch a
  // half-configured outline for a frame.
  g.glowing = true;

  // Fail-closed: a refused rule destroys the twin rather than showing every player where the wire is.
  if (!restrictToTraitors(prop)) return null;
  return prop;
}

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
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  const cls = resolveWeapon(s("sm_ttt_shop_taser_weapon"));
  // Matched by DEFINITION INDEX. This compared `weaponClass(w) === cls`, and `weaponClass` returns
  // "" on this runtime — so the old taser was never removed and `give` added a SECOND one. Only one
  // taser can be held, so the engine dropped the surplus: buying one taser produced one in hand and
  // one on the floor for anybody to pick up.
  removeByDef(slot, TASER_DEF);
  // Deferred a frame: the removal does not free the slot until then, so a same-frame give produced a
  // taser in hand AND one on the floor.
  void nextFrame().then(() => {
    give(slot, cls);
  });
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
// Poison Shots' counter lives in `weaponfx.ts`: the charge is spent on the trigger pull (which is
// also what silences the pistol), not on the hit, so the module that hooks `weapon_fire` owns it.
// This file only READS it, through `poisonShotsLeft`.
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
  const max = n("sm_ttt_shop_gloves_max_uses");
  tell(
    slot,
    forBody
      ? msg("SHOP_ITEM_GLOVES_USED_BODY", left - 1, max)
      : msg("SHOP_ITEM_GLOVES_USED_KILL", left - 1, max),
  );
  if (left - 1 === 0) tell(slot, msgFor(slot, "SHOP_ITEM_GLOVES_WORN_OUT"));
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
  // Tint only, deliberately.
  //
  // The C# also flipped RenderMode to kRenderTransAlpha. That IS reachable now (`m_nRenderMode` is a
  // `RenderMode_t`; an older comment here wrongly said it had no schema equivalent) — but reaching it
  // and wanting it are different questions. kRenderTransAlpha blends against the entity's alpha, and
  // `setEntityColor` sends only `Color`, never alpha. A corpse whose pawn was hidden with
  // `setPawnAlpha(slot, 0)` would then composite against alpha 0 and could vanish — the exact failure
  // this mode has already produced twice. Painting works as-is; adding the flip is only worth doing
  // alongside an explicit opaque alpha, and only after checking it in game.
  colorCorpse(body.ref, body.owner, resolvePaintColor());
  if (left - 1 === 0) tell(slot, msgFor(slot, "SHOP_ITEM_BODY_PAINT_OUT"));
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
 * Resolve `sm_ttt_shop_bodypaint_color`, mirroring `CS2BodyPaintConfig.Load`: HTML hex first, then
 * a known colour name, then GreenYellow. Memoised on the raw string so repeat paints re-parse
 * nothing; paint is spent on a USE press, well outside the shared frame handler.
 *
 * C#'s `Color.FromName` yields transparent black for an unrecognised name (a black corpse). Falling
 * back to the default instead only differs on a misconfigured server, and fails visibly rather than
 * silently making the item useless.
 */
function resolvePaintColor(): Rgb {
  const raw = s("sm_ttt_shop_bodypaint_color");
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
 * (see `cs2/color.ts`). `sm_ttt_shop_camo_visibility` is a 0..1 multiplier, matching the C# config.
 */
function applyCamo(slot: number): void {
  const visibility = n("sm_ttt_shop_camo_visibility");
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
export function placeStation(slot: number, increment: number, budget?: number): boolean {
  const pawn = pawnOf(slot);
  if (pawn === null) return false;
  const hit = pawn.aimTrace({ distance: 128, mask: TraceMask.WorldOnly });
  const at = hit?.endPos ?? pawn.origin;
  if (at === null || at === undefined) return false;

  // The script owns the station's health the way `StationInfo.Health` did: `shootStation` takes it
  // down per bullet and fires `AcceptInput("Kill")` at zero.
  //
  // The prop is nevertheless spawned with that SAME health rather than an unbreakable one, so the
  // engine's own break damage stays a second, independent way to destroy it. `shootStation` is
  // reachable only through `onBulletImpact`, which is wired from plugin.ts's `bullet_impact`
  // subscription; a station whose only destruction path is that one hook is invulnerable for the
  // whole round if the hook is ever missing, which is the worse failure by far. The two models
  // score a bullet slightly differently, so whichever gets there first wins by about one shot —
  // and a prop the engine broke is reaped by `tickStations`' `isValid()` check.
  const maxHealth = n("sm_ttt_shop_healthstation_station_health");
  const ent = createEntity("prop_physics_override", {
    model: STATION_MODEL,
    targetname: `ttt_station_${slot}`,
    health: maxHealth,
  });
  // Store the position the prop actually ends up at, so the bullet-impact test and the effect
  // radius agree — the C# used one `AbsOrigin` for both.
  const z = at.z + 8;
  ent?.teleport([at.x, at.y, z], null, [0, 0, 0]);

  stations.push({
    ref: ent,
    owner: slot,
    increment,
    // C# exposes no ConVar for the hurt station's allowance — `DamageStationConfig` hard-codes
    // -3000 — so a caller that does not pass one gets the budget implied by the sign of the
    // increment, with `sm_ttt_shop_damagestation_total_damage` able to override it if registered.
    budget: budget ?? (increment < 0
      ? n("sm_ttt_shop_damagestation_total_damage") || 3000
      : Math.abs(n("sm_ttt_shop_healthstation_total_health_given"))),
    given: 0,
    health: maxHealth,
    maxHealth,
    tint: -1,
    x: at.x,
    y: at.y,
    z,
    timer: 0,
  });
  return true;
}

/** Apply station effects. `dt` is elapsed seconds. */
function tickStations(dt: number): void {
  if (stations.length === 0) return;
  const interval = Math.max(0.1, n("sm_ttt_shop_healthstation_interval"));
  const range = n("sm_ttt_shop_healthstation_max_range");
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
      st.ref?.acceptInput("Kill");
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
      const next = hp + amount;
      // `DamageStation.applyDamage` dispatched a `PlayerDeathEvent.WithKiller(dominantInfo.Owner)
      // .WithWeapon("[Hurt Station]")` on the tick that would kill. Without it this bare health
      // write reaches the engine with no attacker and the kill scores as the victim's own suicide.
      if (!heals && next <= 0) {
        // A lethal gadget tick must go through `killWithGadget`: a bare health write reaches <= 0 via
        // `slay()`, which produces NO death event, so the corpse, attribution, karma and win check
        // all silently never happen.
        killWithGadget(slot, st.owner, "[Hurt Station]");
      } else {
        setHealth(slot, next);
      }
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
  const sizeSq = n("sm_ttt_shop_tripwire_size_squared");
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
  if (dx * dx + dy * dy + dz * dz > n("sm_ttt_shop_tripwire_max_distance_squared")) return false;

  // Span the gap along the SURFACE NORMAL, not along the player's aim.
  //
  // The C# takes `originTrace.Normal.toAngle()` and traces from the hit point in that direction, so
  // the wire runs perpendicular to the surface it is stuck to and reaches the wall opposite — which
  // is what strings a wire across a doorway. Following the AIM direction instead continues straight
  // INTO the wall just hit, so the second trace ends where it began, `end` collapses onto `start`,
  // and the beam is zero length: the anchor props appear and no wire is ever visible.
  //
  // Three distinct points, which were previously conflated:
  //   surfaceA / surfaceB — where the wall actually is. The ANCHORS go here.
  //   rayStart            — 2u off surfaceA, so the span trace does not begin inside the brush.
  //   beam ends           — pulled 1u off each surface so the wire terminates AT its anchors.
  //
  // Passing `rayStart` as the anchor position is what left the near button hanging in the air: it is
  // already 2u out, and `spawnTripwireProp` nudges another 1u along the normal, so the panel sat 3
  // units off the wall. Drawing the beam all the way to `surfaceB` is what made it overshoot the far
  // anchor and disappear into the wall behind it.
  const nrm = first.normal;
  const nLen = Math.sqrt(nrm.x * nrm.x + nrm.y * nrm.y + nrm.z * nrm.z) || 1;
  const nx = nrm.x / nLen;
  const ny = nrm.y / nLen;
  const nz = nrm.z / nLen;

  const surfaceA = new Vector(first.endPos.x, first.endPos.y, first.endPos.z);
  const rayStart = new Vector(surfaceA.x + nx * 2, surfaceA.y + ny * 2, surfaceA.z + nz * 2);

  // How far a wire may reach for the opposite surface. This was a hardcoded 512 (~13 feet), which is
  // shorter than most rooms and made the item feel broken in anything but a doorway. The C# puts no
  // length on its span trace at all, so this is a cvar with a generous default rather than a constant.
  const span = n("sm_ttt_shop_tripwire_max_span");
  const far = Trace.line(
    rayStart,
    new Vector(rayStart.x + nx * span, rayStart.y + ny * span, rayStart.z + nz * span),
    { mask: TraceMask.WorldOnly },
  );
  // Nothing opposite within the span (an open area): run the wire out along the normal anyway rather
  // than straight up, so it still spans something a player can walk into.
  const surfaceB = far.didHit
    ? far.endPos
    : new Vector(rayStart.x + nx * 128, rayStart.y + ny * 128, rayStart.z + nz * 128);

  // The beam stops at the anchors, not at the brickwork behind them.
  const start = new Vector(surfaceA.x + nx, surfaceA.y + ny, surfaceA.z + nz);
  const end = new Vector(surfaceB.x - nx, surfaceB.y - ny, surfaceB.z - nz);

  const color: [number, number, number, number] = [
    n("sm_ttt_shop_tripwire_color_r"),
    n("sm_ttt_shop_tripwire_color_g"),
    n("sm_ttt_shop_tripwire_color_b"),
    n("sm_ttt_shop_tripwire_color_a"),
  ];
  const beam = Beam.draw(start, end, { color, width: n("sm_ttt_shop_tripwire_thickness") });

  // An anchor at each end, as in the C#: the wire is two panels with a beam strung between them.
  // Each anchor faces out of the surface it is stuck to: the near one along the hit normal, the far
  // one along the opposite (it is on the wall across the gap, facing back).
  const propA = spawnTripwireProp(surfaceA.x, surfaceA.y, surfaceA.z, nx, ny, nz, `ttt_tripwire_a_${slot}`);
  const propB = spawnTripwireProp(surfaceB.x, surfaceB.y, surfaceB.z, -nx, -ny, -nz, `ttt_tripwire_b_${slot}`);
  // Traitor-only outlines over both anchors, so a Traitor can see where a team-mate wired a doorway
  // without walking into it. Innocents see the plain anchors exactly as before.
  //
  // Gated behind `sm_ttt_shop_tripwire_glow` (on by default) so they can be taken out of the picture
  // without a rebuild — they are extra networked props carrying a per-viewer transmit rule, which
  // makes them worth eliminating first if client-side network fatals ever come back.
  const glowOn = b("sm_ttt_shop_tripwire_glow");
  const glowA = !glowOn ? null : spawnTripwireGlow(surfaceA.x, surfaceA.y, surfaceA.z, nx, ny, nz, `ttt_tripwire_glow_a_${slot}`);
  const glowB = !glowOn ? null : spawnTripwireGlow(surfaceB.x, surfaceB.y, surfaceB.z, -nx, -ny, -nz, `ttt_tripwire_glow_b_${slot}`);

  // The C# emitted the wire's whole audible life from its `prop_dynamic`, so prefer the prop and
  // fall back to the beam. Only positional emits — an entity-less `Sound.emit` is a global 2D
  // broadcast, which would tell the whole server a wire just went down.
  const speaker = propA ?? (beam === null ? null : beam.ref);
  if (speaker !== null) Sound.emit(SND_TRIPWIRE_PLACE, { entity: speaker });

  tripwires.push({
    owner: slot,
    placedAt: Server.gameTime,
    beam,
    propA,
    propB,
    glowA,
    glowB,
    ax: start.x, ay: start.y, az: start.z,
    bx: end.x, by: end.y, bz: end.z,
    arming: n("sm_ttt_shop_tripwire_initiation_time"),
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
  const sizeSq = n("sm_ttt_shop_tripwire_size_squared");
  const ffTriggers = b("sm_ttt_shop_tripwire_friendlyfire_triggers");

  for (let i = tripwires.length - 1; i >= 0; i--) {
    const tw = tripwires[i]!;
    if (!tw.alive) {
      tw.beam?.remove();  // BeamHandle has no I/O surface; a beam is a client-side effect, not a networked prop
      tw.propA?.acceptInput("Kill");
      tw.propB?.acceptInput("Kill");
      tw.glowA?.acceptInput("Kill");
      tw.glowB?.acceptInput("Kill");
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
  const power = n("sm_ttt_shop_tripwire_explosion_power");
  const falloff = n("sm_ttt_shop_tripwire_falloff_delay");
  const ffMult = n("sm_ttt_shop_tripwire_friendlyfire_multiplier");
  const owner = tw.owner;
  const forgiveAfter = n("sm_ttt_shop_tripwire_friendlyfire_karma_penalty_time");
  const age = Server.gameTime - tw.placedAt;
  if (tw.beam !== null) Sound.emit(SND_TRIPWIRE_BLAST, { entity: tw.beam.ref });

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    // Measured from the nearest point on the WIRE, not from the anchor it was pinned to.
    //
    // The C# measured from `TripwireInstance.StartPos` — one end — and this ported that faithfully.
    // It only behaves while wires are short: the falloff is steep (~118 damage at 142u, ~11 by
    // 300u), so on a wire spanning a doorway the far half of the span barely scratches anyone. It
    // was measured on a live server — a player standing ON the wire, 142u along it, took 59 and
    // walked away; a second crossing at 168u took 40. A trap that is lethal at one end and
    // cosmetic at the other is not a trap.
    //
    // Distance to the SEGMENT makes the whole length equally dangerous, which is what the wire looks
    // like it does and what a player crossing it expects. The same helper already decides whether the
    // wire was tripped at all, so trip and damage now agree on what "near the wire" means.
    const dist = Math.sqrt(distToSegmentSq(o.x, o.y, o.z + 36, tw.ax, tw.ay, tw.az, tw.bx, tw.by, tw.bz));

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

    const health = pawn.health ?? 0;
    if (health - dealt <= 0) {
      // C# forgives a Traitor killed by a trap that has been sitting there a while — the owner is
      // long gone and it is not their fault; -1 disables the forgiveness entirely.
      if (forgiveAfter !== -1 && reg.roleOf(slot) === RoleId.Traitor && age > forgiveAfter) {
        suppressKarmaOnce(slot);
      }
      // `dealTripwireDamage` dispatched `PlayerDeathEvent.WithKiller(instance.owner)
      // .WithWeapon("[Tripwire]")`. The death itself is already carried by the engine's own
      // `player_death` (the slay inside `setHealth`), which reports no attacker — this hands that
      // event the killer and the cause it has no way to know, rather than emitting a second one.
      killWithGadget(slot, owner, "[Tripwire]");
    } else {
      // C# dispatches a real PlayerDamagedEvent with instance.owner as the attacker, which is what
      // puts the trap's owner on karma's first-damage record. Fresh payload, NOT the exported
      // `sharedDamage` singleton — this runs from the tick, not from the damage hook.
      bus.emit("damage", {
        slot,
        attacker: owner,
        damage: dealt,
        weapon: "[Tripwire]",
        canceled: false,
      });
    }
    // C# applies the health change regardless of whether a listener canceled the event it just
    // dispatched, so `canceled` is deliberately not consulted. A direct health write fires no
    // `player_hurt`, so the damage listener below cannot double-count this emit either.
    setHealth(slot, health - dealt);
  }
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
    const total = n("sm_ttt_shop_tripwire_defuse_time");
    if (tw.defuseProgress >= total) {
      tw.alive = false;
      if (tw.beam !== null) Sound.emit(SND_DEFUSE_DONE, { entity: tw.beam.ref, volume: 0.2 });
      addBalance(slot, n("sm_ttt_shop_tripwire_defuse_reward"), "Defused Tripwire");
      return true;
    }
    // The C# defuse ran on its own `DefuseRate` timer and beeped once per tick; this runs off the
    // USE handler every frame, so the beep is paced back to that rate by hand.
    tw.defuseSound += dt;
    if (tw.defuseSound >= Math.max(0.05, n("sm_ttt_shop_tripwire_defuse_rate"))) {
      tw.defuseSound = 0;
      oneSlot[0] = slot;
      pawn.emitSound(SND_DEFUSE_TICK, { recipients: oneSlot });
    }
    // Same centre-screen route as the compass; the per-frame drain keeps it on screen for as long as
    // the defuse is held, and it clears itself the moment this stops being set.
    setCenterHud(
      slot,
      hudLine(
        msg("SHOP_ITEM_TRIPWIRE_DEFUSING", reg.nameOf(slot), Math.ceil(total - tw.defuseProgress)),
        "#ffdd55",
      ),
    );
    return true;
  }
  return false;
}

// ── poison ───────────────────────────────────────────────────────────────────
/**
 * Apply poison to `victim`, credited to `attacker`. `fromSmoke` marks the Poison Smoke source: the
 * one that does not wash the victim's screen and whose victims leave no corpse behind.
 *
 * The poison damage is a bare health write, which the engine attributes to nobody — `tickPoison`
 * hands the killer to `markGadgetKill` on the lethal tick so the kill still lands on the poisoner.
 */
export function applyPoison(victim: number, attacker = -1, fromSmoke = false): void {
  poisonRemaining[victim] = n("sm_ttt_shop_poisonsmoke_poison_total_damage");
  poisonTimer[victim] = 0;
  poisonSource[victim] = attacker;
  poisonFromSmoke[victim] = fromSmoke ? 1 : 0;
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
  const interval = Math.max(0.05, n("sm_ttt_shop_poisonsmoke_poison_tick_interval") / 1000);
  const perTick = n("sm_ttt_shop_poisonsmoke_poison_damage_per_tick");

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
    if (poisonFromSmoke[slot] === 0) {
      Fade.to(slot, {
        duration: POISON_FADE_DURATION,
        holdTime: POISON_FADE_HOLD,
        color: POISON_FADE_COLOR,
        flags: POISON_FADE_FLAGS,
      });
    }

    const next = (pawn.health ?? 0) - damage;
    // Record the source ONLY on the lethal tick, as `killedWithPoison[player.Id] = shooter` does —
    // stamping it when the poison lands would credit the poisoner for a later kill by someone else.
    // Smoke victims additionally leave no corpse (`PoisonSmokeListener.OnRagdollSpawn` cancels the
    // body outright), which is the fourth argument.
    if (next <= 0) {
      const smoke = poisonFromSmoke[slot] === 1;
      killWithGadget(slot, poisonSource[slot]!, smoke ? "[Poison Smoke]" : "[Poison Shots]", smoke);
    }
    setHealth(slot, next);
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

  const length = n("sm_ttt_shop_compass_length");
  const fov = Math.max(0.001, Math.min(360, n("sm_ttt_shop_compass_fov")));
  const range = n("sm_ttt_shop_compass_max_range");
  const rangeSq = range * range;
  if (compassBuf.length !== length) compassBuf = new Array<string>(length);

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const mode = compass[slot]! as CompassMode;
    if (mode === CompassMode.Off || !reg.isAlive(slot)) {
      setCenterHud(slot, "");
      continue;
    }

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
    if (!found) {
      setCenterHud(slot, "");
      continue;
    }

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

    // Monospace so the strip's cells line up; the glyphs are meaningless if they drift.
    setCenterHud(
      slot,
      hudLine(compassBuf.join(""), "#ffcc00", HUD_FONT_BIG) +
        `<br>${hudLine(distanceBand(Math.sqrt(bestSq)), "#cccccc", HUD_FONT_SMALL)}`,
    );
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
  hasStickers.fill(0);
  hasDna.fill(0);
  hasRevolver.fill(0);
  hasOneHitKnife.fill(0);
  camouflaged.fill(0);
  gloveUses.fill(0);
  paintUses.fill(0);
  compass.fill(0);
  poisonRemaining.fill(0);
  poisonTimer.fill(0);
  poisonSource.fill(-1);
  poisonFromSmoke.fill(0);
  activeC4 = 0;

  for (let i = 0; i < stations.length; i++) stations[i]!.ref?.acceptInput("Kill");
  stations.length = 0;
  for (let i = 0; i < tripwires.length; i++) {
    const tw = tripwires[i]!;
    tw.beam?.remove();  // BeamHandle has no I/O surface; a beam is a client-side effect, not a networked prop
    tw.propA?.acceptInput("Kill");
    tw.propB?.acceptInput("Kill");
    tw.glowA?.acceptInput("Kill");
    tw.glowB?.acceptInput("Kill");
  }
  tripwires.length = 0;
}

/**
 * The TTT bus, kept so the tick-driven effects can dispatch on it. `detonateTripwire` is the one
 * that needs it: the C# `dealTripwireDamage` dispatches a real `PlayerDamagedEvent` for every
 * non-lethal hit, which is what puts the trap's owner on karma's first-damage record.
 */
let bus: EventBus<TttEvents>;

/** Register the damage-driven item behaviours. */
export function installEffects(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;

  eventBus.on(
    "damage",
    (ev) => {
      if (!inProgress() || ev.attacker < 0) return;
      const attacker = ev.attacker;
      const victim = ev.slot;

      // The Taser is checked BEFORE the `canceled` guard below, because a canceled tase is the
      // NORMAL case: `@s2script`-side, `economy.ts` subscribes at Priority.HIGH to pay out
      // "Successful Tase" and cancels the damage there — so by the time this listener ran, `canceled`
      // was already true and the early return skipped the reveal entirely. The player got the payout
      // message and never learned the role, which is exactly the bug. Cancellation is what a tase is
      // SUPPOSED to do, so it must not suppress the scan.
      //
      // The cancel must survive the `player_hurt` fallback path, where the hit has ALREADY landed:
      // if it took the victim below zero they are dead before anything can refund it, and the
      // "scan" would have killed the person it is meant to identify. Force them back to a safe
      // floor as well as cancelling, so a tase is never lethal.
      // SUBSTRING match, not equality. The weapon string's shape depends on which path delivered the
      // damage: the entity pre-hook reports the class (`weapon_taser`) while the `player_hurt`
      // fallback reports the engine's short name (`taser`) — and the fallback is the live path here.
      // An `=== "weapon_taser"` test therefore silently never matched a real tase, so the scan
      // reported nothing at all. The C# guarded with `Contains("taser")` for exactly this reason, and
      // `icons.ts` already uses `includes` on the same event.
      // Gated on the WEAPON only, never on an "owns the taser" flag.
      //
      // This required `hasTaser[attacker] === 1`, and the flag is per-round state cleared by
      // `resetEffects` — so it went to zero on every plugin reload and every round boundary, while the
      // taser stayed in the player's hands. Measured on a live server: a real tase arrived with
      // `hasTaser=0` and the reveal was skipped, yet `economy.ts` (which checks only the weapon
      // string) still paid out "Successful Tase". A tase that pays credits and reveals nothing is the
      // worst of both.
      //
      // The C# `TaserListenCanceler` has no such flag: it reveals for any hit whose weapon contains
      // "taser" and lets HOLDING one be the gate, which is also what makes a taser picked up off the
      // ground behave the same as a bought one.
      if (ev.weapon.includes("taser")) {
        ev.canceled = true;
        const pawn = pawnOf(victim);
        const hp = pawn?.health ?? 0;
        if (hp <= 0) setHealth(victim, 1);
        const role = roleName(reg.roleOf(victim));
        tell(attacker, msgFor(attacker, "TASER_SCANNED", reg.nameOf(victim), role));
        if (hasStickers[attacker] === 1) {
          tell(victim, msgFor(victim, "SHOP_ITEM_STICKERS_HIT"));
          revealRole(victim);
        }
        return;
      }

      // Everything past this point is real damage handling, which a cancel legitimately voids.
      if (ev.canceled) return;

      // One-Shot Revolver: an instant kill, or suicide on a teammate.
      //
      // CS2 reports the weapon as `weapon_deagle` even when the player is holding a revolver — the
      // C# carried an explicit alias for exactly this, and it matters more here because the live
      // path is `player_hurt`, whose weapon string comes straight from the engine field.
      if (hasRevolver[attacker] === 1 && isOneShotWeapon(ev.weapon)) {
        const sameTeam = (reg.roleOf(attacker) === RoleId.Traitor) === (reg.roleOf(victim) === RoleId.Traitor);
        if (sameTeam && !b("sm_ttt_shop_onedeagle_ff")) {
          hasRevolver[attacker] = 0;
          ev.canceled = true;
          tell(attacker, msgFor(attacker, "SHOP_ITEM_DEAGLE_HIT_FF"));
          if (b("sm_ttt_shop_onedeagle_kill_shooter_on_ff")) setHealth(attacker, 0);
          return;
        }
        hasRevolver[attacker] = 0; // one shot only, matching the C# RemoveItem on first hit
        ev.damage = 1000;
        tell(victim, msgFor(victim, "SHOP_ITEM_DEAGLE_VICTIM"));
        return;
      }

      // One-Hit Knife: consumed on the next knife strike.
      if (hasOneHitKnife[attacker] === 1 && KNIVES.has(ev.weapon)) {
        const sameTeam = (reg.roleOf(attacker) === RoleId.Traitor) === (reg.roleOf(victim) === RoleId.Traitor);
        if (sameTeam && !b("sm_ttt_shop_onehitknife_friendly_fire")) return;
        hasOneHitKnife[attacker] = 0;
        ev.damage = 1000;
        return;
      }

      // Poison Shots: a pistol hit applies poison. The charge was already spent on FIRE (see
      // `onWeaponFire` in weaponfx.ts) — the C# `OnDamage` only READS the counter, which is why the
      // shot that spends the last charge lands without poisoning. This is also the source that
      // flashes the victim's screen; Poison Smoke (in `weaponfx.ts`) is the silent one.
      if (poisonShotsLeft(attacker) > 0 && isPistol(ev.weapon)) {
        applyPoison(victim, attacker, false);
        tell(attacker, msgFor(attacker, "SHOP_ITEM_POISON_HIT", reg.nameOf(victim)));
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
  const cls = s("sm_ttt_shop_onedeagle_weapon");
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
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const to = active[i]!;
    tell(to, msgFor(to, "BODY_IDENTIFIED", "Stickers", reg.nameOf(slot), roleName(role)));
  }
}
