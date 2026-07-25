/**
 * Karma — the port of `IKarmaService`, `KarmaUpdateManager`, `KarmaListener` and `KarmaBanner`.
 *
 * Karma tracks whether a player kills the *right* people. Killing across teams earns karma; killing
 * your own side loses it, scaled by how many bad kills you have already racked up this round, and
 * discounted if the victim shot first.
 *
 * Structural differences from the C#:
 *
 * - Karma is a `Float64Array` slot table plus a SteamID map for persistence, not a
 *   `ConcurrentDictionary<string, int>` behind an `async Task<int> Load(IPlayer)` that every caller
 *   blocked on with `.GetAwaiter().GetResult()`.
 * - "Who shot whom first" was a `List<(string, string)>` scanned with `Contains` — an O(n) linear
 *   scan of tuple pairs on every damage tick. Here it is a `Uint8Array` bitmatrix indexed by
 *   `attacker * 64 + victim`: one array read per check.
 * - Updates still batch through a queue (so a multi-kill resolves to one write per player), but the
 *   queue drains synchronously rather than through `Task.Run`.
 */

import { Server } from "@s2script/sdk/server";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { cfg, n, s } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { setScore, tell } from "../cs2/pawn";
import { Player } from "@s2script/cs2";
import { game } from "../game/game";

/** Live karma per slot. */
const karma = new Float64Array(MAX_SLOTS);
/** Karma persisted by SteamID, so a reconnect keeps its value for the map's lifetime. */
const persisted = new Map<string, number>();

/**
 * First-blood matrix: `firstDamage[a * MAX_SLOTS + v]` is 1 when `a` damaged `v` before `v` damaged
 * `a`. Replaces the C# `List<(string,string)>.Contains` linear scan.
 */
const firstDamage = new Uint8Array(MAX_SLOTS * MAX_SLOTS);
/** Bad (same-team) kills per slot this round — the karma-loss multiplier. */
const badKills = new Int32Array(MAX_SLOTS);

/** Pending karma deltas for the round, flushed at round end. */
const pending = new Float64Array(MAX_SLOTS);
let pendingAny = false;

/** Rounds each slot must sit out (karma timeout). */
const timeoutRounds = new Int32Array(MAX_SLOTS);
/** Last time (ms) each slot was warned about low karma. */
const lastWarned = new Float64Array(MAX_SLOTS);

let bus: EventBus<TttEvents>;

/** The maximum karma a player may hold. */
export const MAX_KARMA = 100;

/** Current karma for a slot. */
export function karmaOf(slot: number): number {
  return karma[slot]!;
}

/** Load a connecting player's karma from the persisted table (or the configured default). */
export function loadKarma(slot: number, steamId: string): void {
  const value = persisted.get(steamId);
  karma[slot] = value ?? cfg.karmaDefault;
  setScore(slot, karma[slot]!);
}

/** Write karma for a slot, firing the `karma` event so listeners may veto or rewrite it. */
export function setKarma(slot: number, value: number): void {
  const old = karma[slot]!;
  const clamped = Math.max(0, Math.min(MAX_KARMA, Math.round(value)));
  const ev = bus.emit("karma", { slot, oldKarma: old, karma: clamped, canceled: false });
  if (ev.canceled) return;

  karma[slot] = ev.karma;
  const id = reg.steamIdOf(slot);
  if (id !== "" && id !== "0") persisted.set(id, ev.karma);
  setScore(slot, ev.karma);
}

/** Queue a karma delta; deltas accumulate and are applied once at round end. */
export function queueKarma(slot: number, delta: number): void {
  if (delta === 0) return;
  pending[slot] = pending[slot]! + delta;
  pendingAny = true;
}

/** Apply every queued delta. */
export function flushKarma(): void {
  if (!pendingAny) return;
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const delta = pending[slot]!;
    if (delta === 0) continue;
    setKarma(slot, karma[slot]! + delta);
  }
  pending.fill(0);
  pendingAny = false;
}

/** Rounds this player still has to sit out (0 = none). */
export function timeoutRemaining(slot: number): number {
  return timeoutRounds[slot]!;
}

/**
 * End a karma timeout early and clear the warning cooldown.
 *
 * Needed because karma and the timeout are separate state: raising someone's karma back above the
 * threshold does not, on its own, put them back in the game.
 */
export function clearKarmaTimeout(slot: number): void {
  timeoutRounds[slot] = 0;
  lastWarned[slot] = 0;
}

/**
 * Set a player's karma as an admin. Unlike {@link setKarma} this also lifts any timeout the new
 * value clears, so one command is enough to put a benched player back in the next round.
 */
export function adminSetKarma(slot: number, value: number): void {
  setKarma(slot, value);
  if (karma[slot]! >= cfg.karmaTimeoutThreshold) clearKarmaTimeout(slot);
}

/** Reset the per-round karma bookkeeping. */
export function resetRound(): void {
  firstDamage.fill(0);
  badKills.fill(0);
}

/** Record that `attacker` damaged `victim`, unless `victim` already started it. */
function noteDamage(attacker: number, victim: number): void {
  if (attacker < 0 || victim < 0 || attacker === victim) return;
  // If the victim shot first, this is retaliation — do not mark the attacker as the aggressor.
  if (firstDamage[victim * MAX_SLOTS + attacker] === 1) return;
  firstDamage[attacker * MAX_SLOTS + victim] = 1;
}

/** Did `a` strike `b` first? */
function struckFirst(a: number, b: number): boolean {
  return firstDamage[a * MAX_SLOTS + b] === 1;
}

/**
 * Score a kill. Mirrors the C# `KarmaListener.OnKill` decision table exactly, including the
 * "assume the killer is guilty when there is no damage history" fallback.
 */
function scoreKill(victim: number, killer: number): void {
  if (killer < 0 || killer === victim) return;

  let killerGuilty = struckFirst(killer, victim);
  const victimGuilty = struckFirst(victim, killer);
  if (!killerGuilty && !victimGuilty) killerGuilty = true;

  const vRole = reg.roleOf(victim);
  const kRole = reg.roleOf(killer);
  if (vRole === RoleId.None || kRole === RoleId.None) return;

  let victimDelta = 0;
  let killerDelta = 0;
  let multiplier = 1;

  const sameSide = (vRole === RoleId.Traitor) === (kRole === RoleId.Traitor);
  if (sameSide) {
    if (killerGuilty) badKills[killer] = badKills[killer]! + 1;
    multiplier = Math.max(1, badKills[killer]!);
  }

  switch (vRole) {
    case RoleId.Innocent:
      if (kRole === RoleId.Traitor) return; // a Traitor killing an Innocent is simply their job
      victimDelta = victimGuilty
        ? n("css_ttt_karma_inno_on_inno_victim_guilty")
        : n("css_ttt_karma_inno_on_inno_victim_innocent");
      killerDelta = killerGuilty
        ? n("css_ttt_karma_inno_on_inno_guilty")
        : n("css_ttt_karma_inno_on_inno_innocent");
      break;
    case RoleId.Traitor:
      if (kRole === RoleId.Traitor) {
        victimDelta = victimGuilty
          ? n("css_ttt_karma_traitor_on_traitor_victim_guilty")
          : n("css_ttt_karma_traitor_on_traitor_victim_innocent");
        killerDelta = killerGuilty
          ? n("css_ttt_karma_traitor_on_traitor_guilty")
          : n("css_ttt_karma_traitor_on_traitor_innocent");
      } else {
        killerDelta = n("css_ttt_karma_inno_on_traitor");
      }
      break;
    case RoleId.Detective:
      if (kRole === RoleId.Traitor) {
        killerDelta = n("css_ttt_karma_traitor_on_detective");
      } else {
        victimDelta = victimGuilty
          ? n("css_ttt_karma_inno_on_detective_victim_guilty")
          : n("css_ttt_karma_inno_on_detective_victim_innocent");
        killerDelta = killerGuilty
          ? n("css_ttt_karma_inno_on_detective_guilty")
          : n("css_ttt_karma_inno_on_detective_innocent");
      }
      break;
    default:
      return;
  }

  queueKarma(killer, killerDelta * multiplier);
  queueKarma(victim, victimDelta);
}

/** Grant end-of-round karma to everyone who took part. */
function grantRoundKarma(winner: RoleId): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isParticipating(slot)) continue;
    queueKarma(slot, reg.roleOf(slot) === winner ? cfg.karmaPerRoundWin : cfg.karmaPerRound);
  }
}

/**
 * Enforce the low-karma consequences: below the ban floor runs the configured command; below the
 * timeout threshold benches the player for a few rounds (with a rate-limited warning).
 */
function enforce(slot: number, value: number): void {
  if (value < cfg.karmaMin) {
    const userId = Player.fromSlot(slot)?.userId ?? -1;
    const command = s("css_ttt_karma_low_command");
    if (command !== "" && userId >= 0) {
      // The command is operator-authored config; the user id is an engine integer, so there is no
      // untrusted text in the console string.
      Server.command(command.replace("{0}", String(userId)));
    }
    setKarma(slot, cfg.karmaDefault);
    return;
  }

  if (value >= cfg.karmaTimeoutThreshold) return;
  const now = Date.now();
  if (now - lastWarned[slot]! <= cfg.karmaWarningWindowMs) return;
  lastWarned[slot] = now;
  timeoutRounds[slot] = cfg.karmaRoundTimeout;
}

/** Register every karma listener on the bus. */
export function installKarma(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;

  eventBus.on("damage", (ev) => {
    if (ev.attacker < 0 || ev.canceled) return;
    noteDamage(ev.attacker, ev.slot);
  });

  eventBus.on("death", (ev) => {
    scoreKill(ev.slot, ev.killer);
  });

  eventBus.on("gameState", (ev) => {
    if (ev.state === GameState.InProgress) {
      resetRound();
      return;
    }
    if (ev.state !== GameState.Finished) return;
    grantRoundKarma(game.winner);
    flushKarma();
  });

  // Bench players who are serving a timeout: rewrite their role to Spectator as it is dealt.
  eventBus.on(
    "roleAssign",
    (ev) => {
      const remaining = timeoutRounds[ev.slot]!;
      if (remaining <= 0) return;
      tell(ev.slot, msg("KARMA_WARNING", remaining));
      timeoutRounds[ev.slot] = remaining - 1;
      ev.role = RoleId.Spectator;
    },
    { priority: Priority.HIGH },
  );

  eventBus.on(
    "karma",
    (ev) => {
      enforce(ev.slot, ev.karma);
    },
    { priority: Priority.MONITOR, ignoreCanceled: true },
  );

  eventBus.on("join", (ev) => {
    loadKarma(ev.slot, reg.steamIdOf(ev.slot));
  });
}
