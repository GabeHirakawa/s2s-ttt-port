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

import { cfg } from "../core/cvars";

import { nextPreFrame } from "../core/preframe";
import { Player, type MatchStats } from "@s2script/cs2";
// `HookResult` comes from the events package, NOT from `@s2script/cs2` — even though cs2's `index.d.ts`
// re-exports it (`export { HookResult } from "@s2script/sdk/events"`) and so type-checks perfectly
// either way. cs2 is a TYPES-ONLY package whose runtime module is injected by the host, and that
// injected module does not carry the re-export. Importing it from cs2 therefore yields `undefined` at
// runtime, and `return HookResult.Handled` throws a TypeError on the last statement of the hook — after
// the handler has already done its work, so every symptom pointed at the suppression machinery instead.
// The thrown result collapsed to Continue and the engine broadcast every death to every client: this is
// the kill feed that Innocents could see. Nothing below the plugin was ever at fault.
import { HookResult, type HookResultValue } from "@s2script/sdk/events";
// `fireToClient` lives on the engine-generic Events, not the CS2 typed overlay.
import { Events } from "@s2script/sdk/events";
import type { GameEvent } from "@s2script/sdk/events";
import type { DamageInfo } from "@s2script/sdk/damage";
import { Server } from "@s2script/sdk/server";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { msg, msgFor } from "../core/msgs";
import { Priority, type EventBus } from "../core/bus";
import { sharedDamage, type TttEvents } from "../core/events";
import * as reg from "../core/registry";
import { checkEndConditions, inProgress } from "../game/game";
import { roleName, roleNameFor } from "../game/roles";
import { logDamage, logDeath } from "../game/logger";
import { settleBody, spawnBody } from "./bodies";
import { clearAttributedKills, DEFAULT_HEALTH, pawnOf, setArmor, setHealth, takeAttributedKiller, tell } from "./pawn";
import { resetPawnColor, setPawnAlpha } from "./color";
import { spoofAlive, unspoofAlive, clearSpoof } from "./spoof";
import { refreshInvulnerability } from "./handlers";
import { stripToSidearms, weaponClass, type HeldWeapon } from "./inventory";

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
 * Scoreboard match stats — kills/deaths/assists/damage.
 *
 * TTT hides a death until the body is found, so the engine's own increments have to be undone and
 * banked until the round is decided. This used to be ~190 lines: two hardcoded structural offsets
 * (`m_pActionTrackingServices`, `m_matchStats`), a probe that validated them against plausible
 * values, an operator override file, and a write-verification pass — all of it because nothing
 * resolved a schema offset at runtime.
 *
 * `Player.matchStats` resolves both hops BY NAME at runtime, so the offsets, the probe, the override
 * file and the verification are all gone. It also fixes the feature: the hardcoded pair was WRONG
 * (`+0x7f8`/`+0x98` against a real `+2760`/`+208`), so the probe correctly refused to write and stat
 * hiding was silently off on every build.
 *
 * `notifyChanged()` after a write is what re-networks the sub-object — the scoreboard is rendered
 * client-side, so a write without it changes nothing anyone can see.
 */

/** Per-round kills/assists withheld from the scoreboard until the round is decided. */
const bankedKills = new Int16Array(MAX_SLOTS);
const bankedAssists = new Int16Array(MAX_SLOTS);
/** Whether this slot's death has already been added back (corpse identified). */
const deathRevealed = new Uint8Array(MAX_SLOTS);

/** The four columns TTT rewrites. Named so a caller cannot pass an arbitrary field. */
type StatField = "kills" | "deaths" | "assists" | "damage" | "utilityDamage";

/** This player's match stats, or null when the services pointer is not resolvable yet. */
function statsOf(slot: number): MatchStats | null {
  return Player.fromSlot(slot)?.matchStats ?? null;
}

/**
 * Apply a batch of column edits to one player and re-network ONCE.
 *
 * Batching is not an optimisation, it is the fix for a visible bug: a single death rewrites up to
 * four of the killer's columns, and notifying after each one replicated four partial states in the
 * same frame — the scoreboard flickered through them before settling. One notify per player per
 * event means clients only ever see the finished state.
 */
function editStats(slot: number, edit: (ms: MatchStats) => boolean): void {
  const ms = statsOf(slot);
  if (ms === null) return;
  if (edit(ms)) ms.notifyChanged();
}

/** Overwrite one column and re-network it. */
function setStat(slot: number, field: StatField, value: number): void {
  editStats(slot, (ms) => {
    ms[field] = value;
    return true;
  });
}

/**
 * Add `delta` to one column, floored at 0.
 *
 * The floor is deliberate: a double-fire, or an engine that did not increment in the first place,
 * would otherwise leave a NEGATIVE number sitting in the Kills column — far more conspicuous than
 * the increment being hidden.
 */
function bumpStat(slot: number, field: StatField, delta: number): void {
  if (delta === 0) return;
  editStats(slot, (ms) => bump(ms, field, delta));
}

/** The floored add itself, without the networking — so a batch can apply several before notifying. */
function bump(ms: MatchStats, field: StatField, delta: number): boolean {
  if (delta === 0) return false;
  const cur = ms[field];
  if (cur === null) return false;
  const next = Math.max(0, cur + delta);
  if (next === cur) return false;
  ms[field] = next;
  return true;
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
  // Everything below is the raw match-stats path plus the bank that mirrors it. Banking without the
  // matching subtract is worse than doing neither: a probe that only flips to Enabled later in the
  // round would then hand out kills at round end that were never taken off in the first place.

  bumpStat(victim, "deaths", -1);

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
    editStats(killer, (ms) => {
      bump(ms, "kills", -1);
      bump(ms, "damage", -dmgHealth);
      // The C# zeroes utility damage outright rather than subtracting this kill's share of it.
      ms.utilityDamage = 0;
      // Always true: the utility-damage write is unconditional, so this batch always needs a notify.
      return true;
    });
  }

  // `assisterStats != killerStats` in the C#: one player credited with both keeps the assist. Same
  // gate on both halves for the same reason as above.
  if (assister >= 0 && assister !== killer && assister !== victim) {
    bankedAssists[assister] = bankedAssists[assister]! + 1;
    bumpStat(assister, "assists", -1);
  }
}

/**
 * Undo the damage the engine just added to the attacker's ADR column.
 *
 * Decrement-only, and never re-added — see the module note above.
 */
function rollbackDamageStats(attacker: number, dmgHealth: number): void {
  if (attacker < 0 || dmgHealth <= 0) return;
  bumpStat(attacker, "damage", -dmgHealth);
}

/** Round is over — nothing is hidden any more, so hand back everything that was withheld. */
function revealStats(): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    // One batch per player: three separate notifies here produced the same flicker at round end
    // that the death path did, on everyone at once.
    const revealDeath = !reg.isAlive(slot) && deathRevealed[slot] === 0;
    if (revealDeath) deathRevealed[slot] = 1;
    const kills = bankedKills[slot]!;
    const assists = bankedAssists[slot]!;
    if (!revealDeath && kills === 0 && assists === 0) continue;
    editStats(slot, (ms) => {
      let touched = false;
      if (revealDeath) touched = bump(ms, "deaths", 1) || touched;
      if (kills > 0) touched = bump(ms, "kills", kills) || touched;
      if (assists > 0) touched = bump(ms, "assists", assists) || touched;
      return touched;
    });
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
      bumpStat(slot, "deaths", 1);
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
/**
 * The bus, captured from the death hook so {@link killWithGadget} can drive the same path.
 *
 * `player_death` reaches us for engine kills, which is where this is set; a gadget kill needs the bus
 * without an event to carry it.
 */
let deathBus: EventBus<TttEvents> | null = null;
/** One-shot diagnostics for the recipient-scoping surface. */
let warnedNoRecipients = false;
let loggedRecipientsOnce = false;
/** One-shot: a throwing `handleDeath` would otherwise silently defeat feed suppression. */
let warnedDeathThrew = false;

/** Give the gadget-kill path a bus before any engine death has happened. */
export function setDeathBus(bus: EventBus<TttEvents>): void {
  deathBus = bus;
}

const pendingKiller = new Int32Array(MAX_SLOTS).fill(-1);
const pendingWeapon = new Array<string>(MAX_SLOTS).fill("");
const pendingNoBody = new Uint8Array(MAX_SLOTS);

/**
 * Kill `victim` and credit `killer`, driving the TTT death path DIRECTLY.
 *
 * `pawn.slay()` (CommitSuicide) does NOT produce a `player_death` we receive — verified on a live
 * server: the hook that handles every engine kill never fired once for a slay, while the pawn ended
 * up dead with `hp=0`. Everything TTT does on a death therefore never happened for a gadget kill: no
 * corpse to find, no kill attribution, no karma, no `setAlive(false)`, and — worst — no win check, so
 * a round whose last Innocent died to a tripwire simply never ended.
 *
 * The consequences are run BEFORE the pawn is slain, because `spawnBody` reads the pawn's origin to
 * place the corpse and a slain pawn no longer has one.
 */
export function killWithGadget(
  victim: number,
  killer: number,
  weapon: string,
  suppressBody = false,
): void {
  if (victim < 0 || victim >= MAX_SLOTS) return;
  if (!reg.isAlive(victim)) return;
  const bus = deathBus;
  if (bus === null) return;

  markGadgetKill(victim, killer, weapon, suppressBody);
  // Corpse, attribution, karma, alive-spoof, death event, win check — the same work an engine death
  // does, in the same order.
  handleDeath(bus, victim, killer, -1, weapon, false);
  clearGadgetKill(victim);
  // Now make the engine agree — but on the NEXT FRAME, deliberately, and outside our own call stack.
  //
  // `slay` makes the engine fire `player_death` SYNCHRONOUSLY. Called from here it lands while the V8
  // isolate is still borrowed by whichever handler drove the gadget (a damage hook, a poison tick),
  // so the core's game-event pre-dispatch hits its re-entrancy guard, cannot run JS, and returns
  // Continue. Our `player_death` hook never gets a say, `Events.setRecipients` is never called, and
  // the engine broadcasts the death to every client — a Poison Shot kill showed up in the kill feed
  // for every Innocent on the server, which is exactly the secret this mode is built on keeping.
  //
  // An earlier comment here read that a slay produces no receivable `player_death` at all. That was
  // the right observation and the wrong conclusion: the event fires, our subscriber is just skipped.
  // Deferring one frame drops the borrow, so the death dispatches normally and gets scoped like any
  // engine kill. The extra frame costs nothing — the victim already reads as alive to everyone else
  // through the spoof, and the corpse was placed above while the pawn still had an origin.
  // Armed BEFORE the slay so the event it produces is recognised as already-handled. -2 records
  // "handled, but nobody to credit", which must still be distinguishable from "not a gadget kill".
  gadgetHandledKiller[victim] = killer >= 0 ? killer : -2;
  const dying = victim;
  nextPreFrame(() => { pawnOf(dying)?.slay(); }, { slot: dying });
}

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

export function installDeathFeedSuppressor(): void {

  // Retained as a no-op seam: the suppression now happens in the shim, which is the only layer that
  // sees the client-bound carrier. Plugin-side subscription to it is accepted and never delivered.
}

/**
 * Restrict the death event now being pre-dispatched to `viewers`.
 *
 * Guarded and logged once, because `dispatch_game_event_pre` drops a subscriber that THROWS and logs
 * nothing at all — an unreachable `setRecipients` would silently disable suppression for the rest of
 * the session with no trace of why.
 */
function setDeathViewers(viewers: readonly number[]): void {
  const setter = (Events as unknown as { setRecipients?: (s: readonly number[]) => void }).setRecipients;
  if (typeof setter !== "function") {
    if (!warnedNoRecipients) {
      warnedNoRecipients = true;
      console.log("[ttt] Events.setRecipients unavailable — the kill feed cannot be scoped");
    }
    return;
  }
  try {
    setter.call(Events, viewers);
  } catch (err) {
    if (!warnedNoRecipients) {
      warnedNoRecipients = true;
      console.log(`[ttt] Events.setRecipients threw: ${String(err)}`);
    }
  }
}

/**
 * Who is allowed to see a kill: the killer, plus their fellow Traitors when the killer is one.
 *
 * Shared by the engine-death path and the gadget hand-off below so the two cannot drift — a gadget
 * kill leaking to a wider audience than a gunshot would be just as fatal to the mode.
 */
function viewersForKill(killer: number): number[] {
  const viewers: number[] = [];
  if (killer < 0) return viewers;
  viewers.push(killer);
  if (reg.roleOf(killer) !== RoleId.Traitor) return viewers;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const other = active[i]!;
    if (other !== killer && reg.roleOf(other) === RoleId.Traitor) viewers.push(other);
  }
  return viewers;
}

/**
 * Victims whose death `killWithGadget` has ALREADY fully processed, and the killer it credited.
 *
 * The engine event that follows the deferred slay is then a formality: every consequence has run, so
 * it must be scoped and suppressed WITHOUT running them a second time. Without this the corpse, the
 * karma adjustment and the win check would all fire twice for one gadget kill.
 */
const gadgetHandledKiller = new Int32Array(MAX_SLOTS).fill(-1);

export function onDeathPre(bus: EventBus<TttEvents>, ev: GameEvent): HookResultValue | void {
  deathBus = bus;
  const victim = ev.getPlayerSlot("userid");
  if (victim < 0) return;

  invalidatePawnCache();
  // Cheap idempotent guard; see `installMatchStats` for why the install is not left to the caller.
  installMatchStats(bus);

  // A gadget kill that has already been processed in full: scope the feed, run nothing else.
  //
  // `killWithGadget` does every consequence itself and then slays the pawn a frame later, which is
  // what produces THIS event. Falling through would spawn a second corpse, adjust karma twice and
  // re-run the win check. The event is still worth handling rather than ignoring, because it is the
  // one and only thing that decides who sees the kill feed entry.
  if (gadgetHandledKiller[victim]! >= 0 || gadgetHandledKiller[victim] === -2) {
    const credited = gadgetHandledKiller[victim]!;
    gadgetHandledKiller[victim] = -1;
    setDeathViewers(viewersForKill(credited < 0 ? -1 : credited));
    return HookResult.Handled;
  }

  // What the ENGINE reported. Kept separate from the repaired `killer` below — see
  // `rollbackDeathStats` for why the stat bookkeeping must run off this one and not off that one.
  const engineKiller = ev.getPlayerSlot("attacker");
  const assister = ev.getPlayerSlot("assister");

  // UNCONDITIONAL, above the round-state gate — the C# calls `hideAndTrackStats` before its own
  // `State.IN_PROGRESS` early-return because the engine has already written these columns by the
  // time a pre-hook runs, and suppressing the broadcast does not undo them.
  rollbackDeathStats(victim, engineKiller, assister, ev.getInt("dmg_health"));

  // A death OUTSIDE a live round is still a death, and it was leaking the whole feed.
  //
  // Bots (and players) keep fighting through the end-of-round window — damage is deliberately allowed
  // while FINISHED — and every one of those deaths took this early return, so it was never scoped and
  // the engine broadcast it to everyone. That is a large share of the entries still appearing in the
  // feed. There are no roles to respect here, so it is scoped to the killer alone: they already see
  // their own kill client-side, and nobody else has any business being told.
  if (!inProgress()) {
    const lone = engineKiller >= 0 && engineKiller !== victim ? [engineKiller] : [];
    setDeathViewers(lone);
    return HookResult.Handled;
  }

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

  // NAME THE VIEWERS instead of rebuilding the event for them.
  //
  // CS2 fans a game event out to clients as one message PER CLIENT, so `HookResult.Handled` alone is
  // all-or-nothing: it either hides a death from everybody or from nobody. `Events.setRecipients` tells
  // the shim which of those per-client posts to let through, so the REAL event — with every field the
  // engine populated, assister and hit modifiers included — reaches exactly the viewers entitled to it.
  //
  // Who is entitled: the killer (they already see their own kill client-side, and withholding the
  // server copy only desynchronises their feed) and, when the killer is a Traitor, their fellow
  // Traitors. Everyone else learns nothing — which is the whole point of the mode.
  //
  // This replaces a loop that re-fired a hand-rebuilt copy of the event to each Traitor. That copy
  // could only ever carry the fields we thought to include, and it double-entered the killer's feed.
  const viewers = viewersForKill(killer);
  // CONTAINED. A throw anywhere in here unwinds out of this pre-hook, so the handler never reaches its
  // `return HookResult.Handled` below — and `dispatch_game_event_pre` treats a throwing subscriber as
  // `Err(())` and drops its result SILENTLY, with no log. The chain then collapses to Continue, the
  // engine broadcasts the death untouched, and every client sees the kill feed. One misbehaving `death`
  // listener (karma, DNA, stats, the win check — TTT's own EventBus.emit has no try/catch either) is
  // therefore enough to defeat the suppression on every single death, invisibly.
  //
  // The consequences of a death matter, but not at the price of leaking who killed whom: the throw is
  // logged and the hook still returns Handled.
  try {
    handleDeath(bus, victim, killer, assister, cause, headshot);
  } catch (err) {
    if (!warnedDeathThrew) {
      warnedDeathThrew = true;
      const detail = err instanceof Error && err.stack !== undefined ? err.stack : String(err);
      console.log(`[ttt] handleDeath threw — death consequences incomplete: ${detail}`);
    }
  }

  // The mask is set HERE — after `handleDeath`, immediately before returning — and not before it.
  //
  // The mask is a single global slot consumed by the shim on the next suppressing FireEvent. Setting it
  // before `handleDeath` left a window in which anything that fires a game event (a corpse spawn, a
  // sound, a nested dispatch) would have ITS pre-hook consume our mask, so the death then fanned out
  // unscoped. That is exactly the intermittency observed: suppression worked for some deaths and not
  // others, depending on what `handleDeath` happened to do.
  setDeathViewers(viewers);

  // Suppressed for EVERY client by returning Handled: the shim carries that decision through to the
  // `CMsgSource1LegacyGameEvent` post that actually delivers the event, so nobody outside the
  // per-client re-fire above (Traitors) learns of this death.
  //
  // No field-blanking fallback here any more. Rewriting `attacker` to the victim did hide WHO killed
  // whom, but it left every death visible as a suicide — which is its own lie, and a bad one in a mode
  // built on not knowing who is dead.
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
      // `Kill` input, not a direct remove — see the note in bodies.ts. A recycled index is what
      // crashes clients with `CopyExistingEntity`.
      body.ref.acceptInput("Kill");
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
      // PRE, not POST — the C# runs the same pass from `Server.NextWorldUpdate`
      // (`BodySpawner.correctRagdoll`), which drains pre-simulation. `settleBody` re-parents and
      // teleports a live ragdoll and `setPawnAlpha` rewrites a networked field on a pawn every client
      // holds; doing that in the POST drain puts both between the engine freeing indices and the
      // snapshot. See core/preframe.ts.
      nextPreFrame(() => {
        if (!corpse.ref.isValid()) return;
        // Both steps are individually switchable — see `sm_ttt_body_settle` / `sm_ttt_body_hidepawn`.
        // Clients have hard-crashed with `CopyExistingEntity: missing client entity N` on kills, and
        // turning corpses off entirely removed all three of the ragdoll, the settle and the hide, so
        // it never isolated which one.
        if (cfg.bodySettle) settleBody(corpse);
        if (cfg.bodyHidePawn) setPawnAlpha(victimSlot, 0);
      }, { slot: victimSlot });
      // Exactly ONE pass, matching the C#'s single `NextWorldUpdate(correctRagdoll)`. Extra passes
      // at +250ms/+700ms were tried and make the corpse convulse: by then the ragdoll is simulating,
      // so each re-teleport yanks a settling body back to its spawn point and physics fights back.
    }
  }

  logDeath(victim, killer, weapon);

  if (killer >= 0 && killer !== victim) {
    const killerRole = reg.roleOf(killer);
    if (killerRole !== RoleId.None) {
      tell(victim, msgFor(victim, "ROLE_REVEAL_DEATH", roleNameFor(victim, killerRole)));
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
    // CLAMPED to the pawn's own ceiling. `remaining + dealt` is the health they had before the hit
    // only while the hit was survivable — a TASER deals 500, so a cancelled tase refunded 500 onto a
    // 100-HP player. Worse, `setHealth` raises `maxHealth` to fit anything larger, so the victim kept
    // a 500-HP ceiling for the rest of the round: one tase made someone effectively unkillable.
    //
    // The ceiling is read BEFORE the write so a hit that already inflated it cannot be laundered into
    // the clamp.
    const cap = pawnOf(victim)?.maxHealth ?? DEFAULT_HEALTH;
    setHealth(victim, Math.min(remaining + dealt, cap));
    if (dmgArmor > 0) setArmor(victim, armor + dmgArmor);
    return;
  }
  damageDiag.applied++;
  if (ev.damage !== dealt) {
    // Apply the delta a listener asked for (e.g. the One-Shot Revolver raising it to lethal).
    // Clamped upward for the same reason as the refund above: a listener that REDUCES a 500-damage
    // taser hit would otherwise hand the victim a health total — and a max-health ceiling — far above
    // anything they should have.
    const cap = pawnOf(victim)?.maxHealth ?? DEFAULT_HEALTH;
    const target = Math.min(remaining + dealt - ev.damage, cap);
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
  // A respawn ends any lingering illusion — they really are alive now. `clearSpoof`, NOT
  // `unspoofAlive`: the latter writes real DEAD state, which on a freshly spawned pawn kills it.
  clearSpoof(slot);

  // Every round starts like a pistol round: you spawn with your pistol and knife, and everything
  // else is on the map to be picked up.
  //
  // The spawn is the ONLY place this belongs. A respawn does not clear what a player was carrying, so
  // whatever they held at the end of the last round — including anything grabbed off the floor in the
  // seconds before the restart — came back with them, and they began the new round already armed.
  // Stripping here, and only here, resets the arsenal without touching the scavenging that follows:
  // the 15-second countdown and the whole round remain theirs to pick up from and KEEP.
  if (cfg.stripOnAssign) stripToSidearms(slot);
}
