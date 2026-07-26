/**
 * Death and damage — the port of `CombatHandler`, `DamageCanceler`, `BodySpawner` and
 * `PlayerStatsTracker`.
 *
 * TTT hides deaths: when a player dies, only the killer (and, if the killer is a Traitor, the other
 * Traitors) see the kill feed entry. Everyone else keeps seeing the victim as alive until their
 * corpse is found. That means:
 *
 *   - `player_death` is suppressed pre-broadcast and re-fired to a chosen recipient set,
 *   - the controller's `pawnIsAlive` mirror is forced back on,
 *   - a ragdoll body is spawned for others to discover,
 *   - the scoreboard's K/D/A/damage columns are rolled back and re-revealed later (see below).
 *
 * The C# needed two damage paths — a `player_hurt` game event on Windows and a
 * `CBaseEntity::TakeDamage` vfunc hook elsewhere — because only the latter can *modify* damage.
 * s2script exposes a single portable `ctx.entities.onDamage` pre-hook that does both, so there is
 * one path here.
 */

import { nextFrame } from "@s2script/sdk/timers";
import { HookResult, Player, type HookResultValue } from "@s2script/cs2";
// `fireToClient` lives on the engine-generic Events, not the CS2 typed overlay.
import { Events } from "@s2script/sdk/events";
import type { GameEvent } from "@s2script/sdk/events";
import type { DamageInfo } from "@s2script/sdk/damage";
import { Server } from "@s2script/sdk/server";
import { config } from "@s2script/sdk/config";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { msg } from "../core/msgs";
import { Priority, type EventBus } from "../core/bus";
import { sharedDamage, type TttEvents } from "../core/events";
import * as reg from "../core/registry";
import { checkEndConditions, inProgress } from "../game/game";
import { roleName } from "../game/roles";
import { logDamage, logDeath } from "../game/logger";
import { settleBody, spawnBody } from "./bodies";
import { clearAttributedKills, setArmor, setHealth, takeAttributedKiller, tell } from "./pawn";
import { resetPawnColor, setPawnAlpha } from "./color";
import { spoofAlive, unspoofAlive } from "./spoof";
import { refreshInvulnerability } from "./handlers";
import { weaponClass, type HeldWeapon } from "./inventory";

/** Maps a pawn entity index back to the slot that owns it — filled lazily per damage event. */
function slotOfPawn(entityIndex: number): number {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const p = Player.fromSlot(slot);
    const pawn = p === null ? null : p.pawn;
    if (pawn !== null && pawn.ref.index === entityIndex) return slot;
  }
  return -1;
}

/**
 * Slot lookup cache for the damage hook, keyed by pawn entity index.
 *
 * `onDamage` fires per bullet; resolving the victim by scanning every connected player would be
 * O(players) per hit. Pawn entity indices are stable for a life, so the mapping is cached and
 * invalidated wholesale on spawn/death/round change.
 */
const pawnToSlot = new Map<number, number>();

/** Server time at which the damage PRE-hook last handled a hit on each victim. */
const preHookHandledAt = new Float64Array(MAX_SLOTS).fill(-1);

/** Diagnostic counters, surfaced by `ttt status`. */
export const damageDiag = {
  hits: 0,
  fallbackHits: 0,
  noVictim: 0,
  unresolvedVictim: 0,
  canceled: 0,
  applied: 0,
};

/** Drop the pawn→slot cache (a pawn index may be recycled after a respawn). */
export function invalidatePawnCache(): void {
  pawnToSlot.clear();
}

function resolveSlot(entityIndex: number): number {
  const hit = pawnToSlot.get(entityIndex);
  if (hit !== undefined) return hit;
  // Cache misses too (-1): most damage inflictors are grenades and world geometry, and re-scanning
  // every connected player for each of those would make the hook O(players) per hit.
  const slot = slotOfPawn(entityIndex);
  pawnToSlot.set(entityIndex, slot);
  return slot;
}

/**
 * Damage pre-hook. Publishes a `damage` event that listeners may cancel (Taser, One-Hit Knife,
 * out-of-round protection) or rescale, then writes the result back onto the live `DamageInfo`.
 *
 * NOTE: `info` is a block-scoped view — nothing here may await, and nothing may retain it. The
 * `damage` payload is the shared singleton for the same reason.
 */
export function onDamage(bus: EventBus<TttEvents>, info: DamageInfo): HookResultValue | void {
  damageDiag.hits++;
  const victimRef = info.victim;
  if (victimRef === null) {
    damageDiag.noVictim++;
    return;
  }
  const victim = resolveSlot(victimRef.index);
  if (victim < 0) {
    damageDiag.unresolvedVictim++;
    return;
  }

  const attackerRef = info.attacker;
  const attacker = attackerRef === null ? -1 : resolveSlot(attackerRef.index);

  const ev = sharedDamage;
  ev.slot = victim;
  ev.attacker = attacker;
  ev.damage = info.damage;
  ev.weapon = attacker < 0 ? "" : activeClassOf(attacker);
  ev.canceled = false;

  bus.emit("damage", ev);

  if (ev.canceled) {
    damageDiag.canceled++;
    preHookHandledAt[victim] = Server.gameTime;
    info.damage = 0;
    return HookResult.Handled;
  }
  damageDiag.applied++;
  preHookHandledAt[victim] = Server.gameTime;
  if (ev.damage !== info.damage) info.damage = ev.damage;

  if (inProgress() && attacker >= 0 && attacker !== victim && ev.damage > 0) {
    logDamage(victim, attacker, ev.weapon, Math.round(ev.damage));
  }
}

/** The class of the attacker's deployed weapon, without allocating. */
function activeClassOf(slot: number): string {
  const p = Player.fromSlot(slot);
  const pawn = p === null ? null : p.pawn;
  if (pawn === null) return "";
  return weaponClass(pawn.activeWeapon as HeldWeapon | null);
}

// ── scoreboard stats ─────────────────────────────────────────────────────────
/**
 * Hiding the scoreboard — the port of `CombatHandler.hideAndTrackStats` + `PlayerStatsTracker`.
 *
 * The engine writes K/D/A and the damage (ADR) column into
 * `CCSPlayerController::m_pActionTrackingServices->m_matchStats` BEFORE the `player_death` /
 * `player_hurt` pre-hooks run, and it networks them independently of the event broadcast. So
 * suppressing the broadcast hides the kill feed and nothing else: press TAB after a gunshot and the
 * Kills/Deaths columns name both the killer and the victim, and a Traitor who merely *hits* someone
 * is outed by their damage number moving. That is the single largest information leak the port can
 * have, so the original undoes the engine's write on the spot and re-applies it later:
 *
 *   - a death is subtracted immediately and added back when the corpse is identified (or at round
 *     end, for a body nobody ever found),
 *   - a kill/assist is subtracted immediately, banked privately, and flushed at round end,
 *   - damage is subtracted and NEVER added back — the C# banks it in `RoundData.Damage` and
 *     `revealKills()` only ever flushes Kills and Assists, so ADR stays hidden for good.
 *
 * `m_pActionTrackingServices` is a pointer member that the generated schema does not expose (there
 * is no `*Services` sub-object on `CCSPlayerController` in schema.generated.d.ts), so the only route
 * is `EntityRef`'s raw pointer-chain surface. Offsets are build-specific: they are validated before
 * the first write and the whole feature no-ops if they do not check out — see `probeStats`.
 */
const enum StatsMode {
  /** Offsets not validated yet. */
  Unknown = 0,
  /** Validated — the raw path is live. */
  Enabled = 1,
  /** Validation failed; every raw read/write is a no-op for the rest of the session. */
  Disabled = 2,
}

/**
 * Field offsets inside `CSMatchStats_t`. It derives `CSPerRoundStats_t`, where these four live; that
 * base block has been stable across CS2 schema revisions, which is why only the two structural
 * offsets below are overridable.
 */
const F_KILLS = 0x30;
const F_DEATHS = 0x34;
const F_ASSISTS = 0x38;
const F_DAMAGE = 0x3c;
const F_UTILITY_DAMAGE = 0x5c;

/**
 * The two STRUCTURAL offsets — `CCSPlayerController::m_pActionTrackingServices` (the pointer hop)
 * and `CCSPlayerController_ActionTrackingServices::m_matchStats` (the block base).
 *
 * These move with the game build. The values below come from a CS2 client schema dump and are a
 * starting point, not a guarantee: nothing in either @s2script package resolves a schema offset at
 * runtime, so there is no way to derive them here. If they are wrong on a given build the probe
 * below refuses to write anything and says so on the console — the operator then supplies the
 * correct pair in `ttt_offsets.json` rather than rebuilding the plugin.
 */
let actionTrackingOff = 0x7f8;
let matchStatsOff = 0x98;
/** The pointer path handed to `read*Via`/`write*Via`. Reused so the hot path allocates nothing. */
const statsChain = [actionTrackingOff];

/**
 * Operator override for the two offsets above, read once on the first probe:
 * `{ "actionTracking": 2040, "matchStats": 152 }` — plain JSON numbers, `0x…` strings are not
 * parsed. Lives in the configs directory, alongside `phrases_file`.
 */
const OFFSETS_FILE = "ttt_offsets.json";

let statsMode: StatsMode = StatsMode.Unknown;
/** Failed evidence checks so far — the shape can be right before the engine has anything to show. */
let statsProbes = 0;
/** Has a write been read back yet? The first one is verified, then trusted. */
let statsWriteVerified = false;

/** A kill/death/assist column above this is not a kill/death/assist column. */
const MAX_PLAUSIBLE_COUNT = 1000;
/** Same idea for the damage column: real ADR totals do not reach six figures. */
const MAX_PLAUSIBLE_DAMAGE = 100000;
/** Retries before the offsets are declared wrong: the first hits are not always attributable. */
const MAX_STAT_PROBES = 8;
/** Canonical user-space pointer bounds — anything outside is not a pointer. */
const MIN_PTR = 0x10000n;
const MAX_PTR = 0x800000000000n;

/** Per-round kills/assists withheld from the scoreboard until the round is decided. */
const bankedKills = new Int16Array(MAX_SLOTS);
const bankedAssists = new Int16Array(MAX_SLOTS);
/** Whether this slot's death has already been added back (corpse identified). */
const deathRevealed = new Uint8Array(MAX_SLOTS);

function readStat(p: Player, field: number): number | null {
  return p.ref.readInt32Via(statsChain, matchStatsOff + field);
}

/** Give up on the raw path for the rest of the session, saying why exactly once. */
function disableStats(why: string): void {
  statsMode = StatsMode.Disabled;
  console.log(`[ttt] WARN: scoreboard stat hiding is OFF: ${why}. ` +
      `Supply the correct offsets in "${OFFSETS_FILE}" ({"actionTracking":N,"matchStats":N}).`,
  );
}

function loadOffsetOverrides(): void {
  const raw = config.readFile(OFFSETS_FILE);
  if (raw === null) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const rec = parsed as Record<string, unknown>;
    const at = rec.actionTracking;
    const ms = rec.matchStats;
    if (typeof at === "number" && at > 0) {
      actionTrackingOff = at;
      statsChain[0] = at;
    }
    if (typeof ms === "number" && ms >= 0) matchStatsOff = ms;
  } catch (err) {
    console.log(`[ttt] ERROR: ${OFFSETS_FILE} is not valid JSON: ${String(err)}`);
  }
}

function plausibleCount(v: number): boolean {
  return v >= 0 && v < MAX_PLAUSIBLE_COUNT;
}

/**
 * Decide whether the offsets above name what they claim to, using the one moment where the answer
 * is knowable: the engine has JUST applied the increment this hook exists to undo, so the field we
 * were called about must already show it (`atLeast`).
 *
 * Three gates, all read-only — nothing is written until every one of them passes:
 *
 *  1. memory safety. The value at `actionTrackingOff` must LOOK like a user-space pointer before
 *     anything dereferences it. A wrong offset lands on floats or small ints, and `readInt32Via`
 *     would happily deref whatever it finds; the alignment + range test rejects both shapes.
 *  2. shape. All four counters must read as plausible small non-negative numbers — this is what
 *     catches an offset that resolves to a *neighbouring* services pointer.
 *  3. evidence. The counter for `field` must already carry the engine's increment.
 *
 * A gate-1 failure is fatal (the pointer is simply not there). A gate-3 failure only costs a retry:
 * the very first hit of a session can be self-damage or an unattributed world hit.
 */
function probeStats(slot: number, field: number, atLeast: number): void {
  const p = Player.fromSlot(slot);
  if (p === null) return;
  if (statsProbes === 0) loadOffsetOverrides();
  statsProbes++;

  const ptr = p.ref.readUInt64(actionTrackingOff);
  if (ptr === null || ptr < MIN_PTR || ptr >= MAX_PTR || (ptr & 7n) !== 0n) {
    disableStats(`no services pointer at controller+0x${actionTrackingOff.toString(16)}`);
    return;
  }

  const kills = readStat(p, F_KILLS);
  const deaths = readStat(p, F_DEATHS);
  const assists = readStat(p, F_ASSISTS);
  const damage = readStat(p, F_DAMAGE);
  if (kills === null || deaths === null || assists === null || damage === null) {
    disableStats("the match-stats block did not resolve");
    return;
  }
  if (
    !plausibleCount(kills) ||
    !plausibleCount(deaths) ||
    !plausibleCount(assists) ||
    damage < 0 ||
    damage > MAX_PLAUSIBLE_DAMAGE
  ) {
    disableStats(`implausible counters (${kills}/${deaths}/${assists}/${damage})`);
    return;
  }

  const observed = field === F_DAMAGE ? damage : field === F_DEATHS ? deaths : kills;
  if (observed < atLeast) {
    if (statsProbes >= MAX_STAT_PROBES) disableStats("the counters never moved with the engine");
    return;
  }
  statsMode = StatsMode.Enabled;
}

/** Overwrite one match-stats field and re-network the sub-object. */
function setStat(slot: number, field: number, value: number): void {
  if (statsMode !== StatsMode.Enabled) return;
  const p = Player.fromSlot(slot);
  if (p === null) return;
  if (!p.ref.writeInt32Via(statsChain, matchStatsOff + field, value)) return;
  // The exact mirror of the C#'s `SetStateChanged(player, "CCSPlayerController",
  // "m_pActionTrackingServices")`: notifying the controller-level pointer is what re-networks the
  // whole sub-object. (The C# also fires two `CSPerRoundStats_t` notifies; the SDK has no
  // chain-notify and the controller-level one is the one that does the work.)
  p.ref.notifyStateChanged(actionTrackingOff);
}

/**
 * Add `delta` to one match-stats field, floored at 0.
 *
 * The floor is deliberate: a mis-resolved offset, a double-fire or an engine that did not increment
 * in the first place would otherwise leave a NEGATIVE number sitting in the Kills column, which is
 * far more conspicuous than the increment being hidden.
 */
function bumpStat(slot: number, field: number, delta: number): void {
  if (statsMode !== StatsMode.Enabled || delta === 0) return;
  const p = Player.fromSlot(slot);
  if (p === null) return;
  const cur = p.ref.readInt32Via(statsChain, matchStatsOff + field);
  if (cur === null) return;
  const next = Math.max(0, cur + delta);
  if (next === cur) return;
  if (!p.ref.writeInt32Via(statsChain, matchStatsOff + field, next)) return;
  p.ref.notifyStateChanged(actionTrackingOff);

  // Verify the very first write actually stuck. A field the engine re-derives (or an offset that
  // reads fine but is not writable) would silently do nothing forever otherwise.
  if (!statsWriteVerified) {
    statsWriteVerified = true;
    if (p.ref.readInt32Via(statsChain, matchStatsOff + field) !== next) {
      disableStats("the first stat write did not stick");
    }
  }
}

/**
 * Undo everything the engine wrote for this death, and bank what is owed back at round end.
 *
 * Called BEFORE the round-state gate in `onDeathPre`, matching the C#, which runs
 * `hideAndTrackStats` above its own `State.IN_PROGRESS` early-return: the engine incremented these
 * columns regardless of what TTT thinks the round is doing.
 *
 * `killer` is always the attacker the ENGINE reported, never the gadget-repaired one `onDeathPre`
 * resolves further down: these columns only need undoing where the engine actually wrote them, and
 * subtracting a kill the engine never granted would take a real one off the gadget owner's column
 * (the floor in `bumpStat` swallows it) and then hand it back at round end as a kill they never had.
 */
function rollbackDeathStats(
  victim: number,
  killer: number,
  assister: number,
  dmgHealth: number,
): void {
  if (statsMode === StatsMode.Unknown) probeStats(victim, F_DEATHS, 1);
  // Everything below is the raw match-stats path plus the bank that mirrors it. Banking without the
  // matching subtract is worse than doing neither: a probe that only flips to Enabled later in the
  // round would then hand out kills at round end that were never taken off in the first place.
  if (statsMode !== StatsMode.Enabled) return;

  bumpStat(victim, F_DEATHS, -1);

  // A suicide is skipped ENTIRELY — subtract and bank alike. Every script-driven kill reaches the
  // engine through `pawn.slay()`, which reports the victim as their own attacker, so this branch is
  // taken by every gadget kill and every admin slay, not just by a rare rage-quit `kill`.
  //
  // The C# nets to zero here by accident: `hideAndTrackStats` does `killerStats.Kills -= 1` for any
  // non-null Attacker (CombatHandler.cs:99) and `PlayerStatsTracker.OnKill` banks it straight back
  // for any non-null Killer (PlayerStatsTracker.cs:52), and `PlayerDeathEvent.Killer` is `ev.Attacker`
  // — the victim themselves on a suicide. Doing neither reaches the same end state without the
  // round-long window in which the victim's Kills column reads one short, and without the C#'s
  // permanent ADR loss (damage is banked but NEVER re-added, see the module note). What must not
  // happen is one half without the other: gating only the bank quietly destroyed one of the
  // victim's own kills, for good, on every gadget kill and every slay.
  if (killer >= 0 && killer !== victim) {
    bankedKills[killer] = bankedKills[killer]! + 1;
    bumpStat(killer, F_KILLS, -1);
    bumpStat(killer, F_DAMAGE, -dmgHealth);
    // The C# zeroes utility damage outright rather than subtracting this kill's share of it.
    setStat(killer, F_UTILITY_DAMAGE, 0);
  }

  // `assisterStats != killerStats` in the C#: one player credited with both keeps the assist. Same
  // gate on both halves for the same reason as above.
  if (assister >= 0 && assister !== killer && assister !== victim) {
    bankedAssists[assister] = bankedAssists[assister]! + 1;
    bumpStat(assister, F_ASSISTS, -1);
  }
}

/**
 * Undo the damage the engine just added to the attacker's ADR column.
 *
 * Decrement-only, and never re-added — see the module note above.
 */
function rollbackDamageStats(attacker: number, dmgHealth: number): void {
  if (attacker < 0 || dmgHealth <= 0) return;
  if (statsMode === StatsMode.Unknown) probeStats(attacker, F_DAMAGE, dmgHealth);
  bumpStat(attacker, F_DAMAGE, -dmgHealth);
}

/** Round is over — nothing is hidden any more, so hand back everything that was withheld. */
function revealStats(): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    // A death nobody ever found still counts once the round is decided (the C# `revealDeaths`).
    if (!reg.isAlive(slot) && deathRevealed[slot] === 0) {
      deathRevealed[slot] = 1;
      bumpStat(slot, F_DEATHS, 1);
    }
    const kills = bankedKills[slot]!;
    if (kills > 0) bumpStat(slot, F_KILLS, kills);
    const assists = bankedAssists[slot]!;
    if (assists > 0) bumpStat(slot, F_ASSISTS, assists);
  }
  bankedKills.fill(0);
  bankedAssists.fill(0);
}

let statsInstalled = false;

/**
 * Subscribe the reveal half of the stat bookkeeping (the C# `PlayerStatsTracker`).
 *
 * Idempotent, and also called from `onDeathPre` — the rollback is worthless without the matching
 * re-add, so this cannot depend on a caller remembering to wire it. Wiring it explicitly at load is
 * still preferred: it catches the round-start clear before the round's first death.
 */
export function installMatchStats(bus: EventBus<TttEvents>): void {
  if (statsInstalled) return;
  statsInstalled = true;

  // MONITOR so the death is only revealed once the identification has actually settled.
  bus.on(
    "bodyIdentify",
    (ev) => {
      const slot = ev.body.owner;
      if (slot < 0 || slot >= MAX_SLOTS || deathRevealed[slot] === 1) return;
      deathRevealed[slot] = 1;
      bumpStat(slot, F_DEATHS, 1);
    },
    { priority: Priority.MONITOR, ignoreCanceled: true },
  );

  bus.on(
    "gameState",
    (ev) => {
      if (ev.state === GameState.InProgress) {
        bankedKills.fill(0);
        bankedAssists.fill(0);
        deathRevealed.fill(0);
        clearGadgetKills();
        clearAttributedKills();
        return;
      }
      if (ev.state === GameState.Finished) revealStats();
    },
    { ignoreCanceled: true },
  );
}

// ── gadget kill attribution ──────────────────────────────────────────────────
/**
 * Who killed a player with something that is not a weapon.
 *
 * Poison, tripwires and the Traitor hurt station kill by writing health, which reaches the engine
 * with no attacker at all: the corpse records no killer, the DNA Scanner reports "no DNA was found",
 * and karma sees a suicide — the entire risk side of those items disappears. The C# handled this
 * with a `killedWith*` table per item, filled on the tick the damage turned lethal and read back in
 * an `OnRagdollSpawn(BodyCreateEvent)` handler that rewrote `ev.Body.Killer`.
 *
 * Here the pending entry is consumed at the top of `onDeathPre` instead of in a `bodyCreate`
 * listener, so the kill feed, the body, karma, the logger and the role-reveal message all see the
 * same killer rather than only the corpse being repaired.
 *
 * `cs2/pawn.ts` carries a second, killer-only table (`attributeNextDeath`) for callers that cannot
 * import this module without closing a cycle through `handlers.ts`. `onDeathPre` consumes both and
 * prefers this one, which is the only one that can also carry a weapon name and the no-corpse flag.
 */
const pendingKiller = new Int32Array(MAX_SLOTS).fill(-1);
const pendingWeapon = new Array<string>(MAX_SLOTS).fill("");
const pendingNoBody = new Uint8Array(MAX_SLOTS);

/**
 * Record who is about to kill `victim` with a gadget. Call this IMMEDIATELY BEFORE the health write
 * that takes them to <= 0, never when the effect is applied: the C# writes its table only on the
 * lethal tick, so a poisoned player who survives and is shot by someone else half a minute later
 * still credits the person who actually shot them.
 *
 * `suppressBody` is the Poison Smoke rule — its victims leave no corpse to find at all.
 */
export function markGadgetKill(
  victim: number,
  killer: number,
  weapon: string,
  suppressBody = false,
): void {
  if (victim < 0 || victim >= MAX_SLOTS) return;
  pendingKiller[victim] = killer;
  pendingWeapon[victim] = weapon;
  pendingNoBody[victim] = suppressBody ? 1 : 0;
}

function clearGadgetKill(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  pendingKiller[slot] = -1;
  pendingWeapon[slot] = "";
  pendingNoBody[slot] = 0;
}

/** Drop every pending attribution (round boundary — the C# cleared its tables at FINISHED). */
export function clearGadgetKills(): void {
  pendingKiller.fill(-1);
  pendingWeapon.fill("");
  pendingNoBody.fill(0);
}

/**
 * `player_death` pre-hook: suppress the public broadcast and re-fire it only to the killer and (if
 * the killer is a Traitor) their fellow Traitors — the C# `CombatHandler.OnPlayerDeath_Pre`.
 */
export function onDeathPre(bus: EventBus<TttEvents>, ev: GameEvent): HookResultValue | void {
  const victim = ev.getPlayerSlot("userid");
  if (victim < 0) return;

  invalidatePawnCache();
  // Cheap idempotent guard; see `installMatchStats` for why the install is not left to the caller.
  installMatchStats(bus);

  // What the ENGINE reported. Kept separate from the repaired `killer` below — see
  // `rollbackDeathStats` for why the stat bookkeeping must run off this one and not off that one.
  const engineKiller = ev.getPlayerSlot("attacker");
  const assister = ev.getPlayerSlot("assister");

  // UNCONDITIONAL, above the round-state gate — the C# calls `hideAndTrackStats` before its own
  // `State.IN_PROGRESS` early-return because the engine has already written these columns by the
  // time a pre-hook runs, and suppressing the broadcast does not undo them.
  rollbackDeathStats(victim, engineKiller, assister, ev.getInt("dmg_health"));

  if (!inProgress()) return;

  const weapon = ev.getString("weapon");
  const headshot = ev.getBool("headshot");

  // Read-and-clear BOTH pending tables, whichever one ends up being used: a mark is written
  // speculatively, immediately before the lethal health write, so one that never converted into the
  // death it was written for (the write was absorbed by invulnerability, the pawn was already gone,
  // a `damage` listener cancelled the tick) must not survive to eat a later, unrelated death.
  const marked = pendingKiller[victim]!;
  const markedWeapon = pendingWeapon[victim]!;
  clearGadgetKill(victim);
  const attributed = takeAttributedKiller(victim);

  let killer = engineKiller;
  let cause = weapon;
  // Repair the attribution here, ABOVE the kill-feed refire, rather than deep inside `handleDeath`:
  // the feed, the corpse, karma, the logger, the role-reveal message and the DNA Scanner then all
  // name the same killer off this one real death event. Nothing has to emit a second, synthetic
  // `death` to correct itself afterwards — and a second emit would double-fire every subscriber
  // (`special/rounds.ts` speedOnKill has no killer === victim guard).
  //
  // Only when the engine named nobody: a gadget kill reaches it as `pawn.slay()`, which reports the
  // victim as their own attacker. That is the C#'s
  // `if (ev.Body.Killer == null || ev.Body.Killer.Id == ev.Body.OfPlayer.Id)`, and
  // `PoisonSmokeListener.OnRagdollSpawn` (PoisonSmokeListener.cs:141-144) cancels body creation
  // under exactly the same test. The body-suppression half of that rule is deliberately NOT ported
  // (see `handleDeath`): a corpse that never appears is indistinguishable from a broken one.
  if (killer < 0 || killer === victim) {
    if (marked >= 0) {
      killer = marked;
      if (markedWeapon !== "") cause = markedWeapon;
    } else if (attributed >= 0 && attributed !== victim) {
      // `pawn.attributeNextDeath` — the killer-only table, for the callers that cannot import this
      // module without closing a cycle through `handlers.ts`.
      killer = attributed;
    }
  }

  // Re-fire to the recipients who are allowed to see it, before we suppress the broadcast.
  // The C# guards on `ev.Attacker != null` only, so a suicide still reaches the victim's own feed.
  if (killer >= 0) {
    const victimUserId = Player.fromSlot(victim)?.userId ?? -1;
    const killerUserId = Player.fromSlot(killer)?.userId ?? -1;
    // The C# re-fires the ORIGINAL event object, so every field the engine populated survives.
    // Rebuilding only userid/attacker/weapon/headshot stripped the one feed TTT deliberately shows
    // of the assist name and of every hit modifier the icons are drawn from. One allocation per
    // death, same as before. `distance`/`dmg_*`/`hitgroup`/`weapon_*` are left out: nothing renders
    // them, and `distance` is the one field whose float inference through `fireToClient` cannot be
    // confirmed from the stubs.
    const fields: Record<string, string | number | boolean> = {
      userid: victimUserId,
      attacker: killerUserId,
      weapon,
      headshot,
      assistedflash: ev.getBool("assistedflash"),
      attackerblind: ev.getBool("attackerblind"),
      attackerinair: ev.getBool("attackerinair"),
      noscope: ev.getBool("noscope"),
      thrusmoke: ev.getBool("thrusmoke"),
      penetrated: ev.getInt("penetrated"),
      dominated: ev.getInt("dominated"),
      revenge: ev.getInt("revenge"),
    };
    // Only when there IS one: `assister` is a player field, and a stamped -1 would make the feed
    // render a bogus assist on every single kill.
    if (assister >= 0) {
      const assisterUserId = Player.fromSlot(assister)?.userId ?? -1;
      if (assisterUserId >= 0) fields.assister = assisterUserId;
    }
    Events.fireToClient(killer, "player_death", fields);

    if (reg.roleOf(killer) === RoleId.Traitor) {
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) {
        const other = active[i]!;
        // Only the killer is skipped (they were served above), matching the C# recipient loop: a
        // Traitor killed by a fellow Traitor still gets their own death notice.
        if (other === killer) continue;
        if (reg.roleOf(other) === RoleId.Traitor) {
          Events.fireToClient(other, "player_death", fields);
        }
      }
    }
  }

  handleDeath(bus, victim, killer, assister, cause, headshot);
  // Suppress the public broadcast: nobody else learns this player died.
  return HookResult.Handled;
}

/**
 * Apply the TTT consequences of a death: body, alive-spoof, events, win check.
 *
 * `killer`/`weapon` are the values `onDeathPre` already resolved — the gadget repair happens up
 * there so that the kill feed sees the same answer this does.
 */
function handleDeath(
  bus: EventBus<TttEvents>,
  victim: number,
  killer: number,
  assister: number,
  weapon: string,
  headshot: boolean,
): void {
  const role = reg.roleOf(victim);
  // ALWAYS spawn a corpse. The C# suppresses body creation for Poison Smoke victims, and that rule
  // was ported — but a suppressed corpse is indistinguishable in-game from a broken one, and
  // finding bodies IS the mechanic. Until the suppression can be verified end-to-end in a real
  // round it stays out: a missing corpse is a far worse failure than an extra one.
  const body = spawnBody(
    victim,
    reg.nameOf(victim),
    role,
    killer,
    killer >= 0 ? reg.nameOf(killer) : "",
    weapon,
    Server.gameTime,
  );

  reg.setAlive(victim, false);
  // Keep the victim reading as alive on every other client's scoreboard until their body is found.
  spoofAlive(victim);

  // The victim's own pawn is hidden and the tracked `prop_ragdoll` IS the corpse — the C# design,
  // which is only now reachable.
  //
  // It was previously the other way round (pawn visible, ragdoll an invisible anchor) because the
  // ragdoll never rendered. That was blamed on model residency; the real cause was that the model
  // path named `characters/models/...`, which holds no `.vmdl` at all. With the path corrected the
  // ragdoll renders AND has a physics representation — so it is trace-hittable and settles where the
  // body actually comes to rest.
  //
  // That split is what made identification unreliable: the anchor stayed frozen at the spot the
  // player died while the visible pawn ragdoll slid on under its own momentum, so USE had to be
  // aimed at an invisible point on the floor instead of at the body. One entity, one position.
  //
  // The pawn is hidden ONLY once the corpse is known to exist. If creation failed or a `bodyCreate`
  // listener cancelled it, the pawn stays visible: an extra body is a cosmetic flaw, no body at all
  // breaks the mechanic the whole mode is built on.
  if (body !== null) {
    const created = bus.emit("bodyCreate", { body, canceled: false });
    if (created.canceled) {
      body.ref.remove();
    } else {
      // Bring the ragdoll into the world, then hide the pawn so there is exactly ONE body.
      //
      // The pawn is hidden inside the settle pass rather than here, and only once the ragdoll is
      // confirmed live: hiding it up front is what produced "STILL NO CORPSES" — at that point the
      // ragdoll was never being detached, so it did not draw, and the only visible body was the one
      // being hidden. Ordering it this way means a corpse can never be hidden before its
      // replacement exists.
      const corpse = body;
      const victimSlot = victim;
      void nextFrame().then(() => {
        if (!corpse.ref.isValid()) return;
        settleBody(corpse);
        setPawnAlpha(victimSlot, 0);
      });
      // Exactly ONE pass, matching the C#'s single `NextWorldUpdate(correctRagdoll)`. Extra passes
      // at +250ms/+700ms were tried and make the corpse convulse: by then the ragdoll is simulating,
      // so each re-teleport yanks a settling body back to its spawn point and physics fights back.
    }
  }

  logDeath(victim, killer, weapon);

  if (killer >= 0 && killer !== victim) {
    const killerRole = reg.roleOf(killer);
    if (killerRole !== RoleId.None) {
      tell(victim, msg("ROLE_REVEAL_DEATH", roleName(killerRole)));
    }
  }

  bus.emit("death", { slot: victim, killer, assister, weapon, headshot });
  checkEndConditions();
}

/**
 * `player_hurt` fallback for the damage bus.
 *
 * `ctx.entities.onDamage` is the proper path — it is a PRE-hook, so a listener can cancel or rescale
 * a hit before it lands. On the current runtime that hook only ever receives the synthetic damage
 * self-test, never real bullet damage, which would leave every damage-driven shop item inert.
 *
 * `player_hurt` fires POST-damage, so this reconstructs the same `damage` event from it and repairs
 * the result afterwards: a cancel restores the health that was taken, and a rescale applies the
 * difference. Behaviourally close, with two honest caveats — the victim sees a momentary dip, and a
 * hit that already reduced them to 0 cannot be undone.
 *
 * Self-disabling: if the real hook ever starts delivering, `damageDiag.hits` becomes non-zero and
 * this path stands down so nothing is processed twice.
 */
export function onPlayerHurt(bus: EventBus<TttEvents>, gev: GameEvent): void {
  const victim = gev.getPlayerSlot("userid");
  if (victim < 0) return;
  const attacker = gev.getPlayerSlot("attacker");
  const dealt = gev.getInt("dmg_health");

  // Above every gate below, because the C# `hideAndTrackStats(EventPlayerHurt)` runs on every hit:
  // the ADR column leaks a Traitor's shot whether or not this path is the one driving the damage
  // bus, so it must still fire if `ctx.entities.onDamage` ever starts delivering and the fallback
  // stands down.
  rollbackDamageStats(attacker, dealt);

  if (dealt <= 0) return;

  // Stand down ONLY for a hit the pre-hook actually handled. A boot-time counter is not safe to
  // key on: the runtime's synthetic damage self-test drives `onDamage` a few times per session,
  // which would otherwise disable this fallback permanently and silently kill every damage-driven
  // item. Per-victim and time-boxed, so the two paths can coexist without double-processing.
  if (victim >= 0 && victim < MAX_SLOTS) {
    if (Server.gameTime - preHookHandledAt[victim]! < 0.2) return;
  }

  const remaining = gev.getInt("health");
  const weapon = gev.getString("weapon");
  // `armor` is what is LEFT after the hit, `dmg_armor` what the hit ate.
  const armor = gev.getInt("armor");
  const dmgArmor = gev.getInt("dmg_armor");

  const ev = sharedDamage;
  ev.slot = victim;
  ev.attacker = attacker;
  ev.damage = dealt;
  // `player_hurt` reports a bare weapon name ("ak47"); the rest of the plugin matches full classes.
  ev.weapon = weapon === "" ? "" : weapon.startsWith("weapon_") ? weapon : `weapon_${weapon}`;
  ev.canceled = false;

  damageDiag.fallbackHits++;
  bus.emit("damage", ev);

  if (ev.canceled) {
    damageDiag.canceled++;
    // Give back exactly what this hit took — health AND armour. The C# cancels in a TakeDamage
    // PRE-hook, so a cancelled hit never touches either; here the hit has already landed, and
    // refunding only health left every taser scan and every friendly-fire block quietly stripping
    // the victim's kevlar for the rest of the round.
    //
    // CAVEAT: this restores the armour VALUE only. A cancelled headshot that broke the helmet still
    // leaves `pawnHasHelmet` false — `player_hurt` carries no helmet field. Unavoidable on a
    // post-damage path, and far smaller than losing the armour outright.
    setHealth(victim, remaining + dealt);
    if (dmgArmor > 0) setArmor(victim, armor + dmgArmor);
    return;
  }
  damageDiag.applied++;
  if (ev.damage !== dealt) {
    // Apply the delta a listener asked for (e.g. the One-Shot Revolver raising it to lethal).
    const target = remaining + dealt - ev.damage;
    setHealth(victim, target);
  }
  if (inProgress() && attacker >= 0 && attacker !== victim) {
    logDamage(victim, attacker, ev.weapon, Math.round(ev.damage));
  }
}

/** `player_spawn`: refresh liveness and drop the stale pawn-index cache. */
export function onSpawn(slot: number): void {
  invalidatePawnCache();
  // Any pending gadget attribution belonged to the life that just ended. `clearAttributedKills` has
  // no per-slot form, but a respawn is either the round boundary (where clearing everything is
  // exactly right) or an admin action, and a stale attribution is worse than a dropped one.
  clearGadgetKill(slot);
  clearAttributedKills();
  refreshInvulnerability(slot);
  // A fresh pawn starts opaque — clears the death-hide and any camouflage from last round.
  resetPawnColor(slot);
  reg.setAlive(slot, reg.computeAlive(slot));
  // A respawn ends any lingering illusion — they really are alive now.
  unspoofAlive(slot);
}
