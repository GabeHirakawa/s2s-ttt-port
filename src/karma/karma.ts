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
 * - Everything the C# keyed by `IPlayer` — whose identity IS the SteamID — is slot-indexed here,
 *   with the two pieces of state that must outlive a slot (karma itself and the sit-out) mirrored
 *   into SteamID maps on disconnect and restored on connect.
 */

import { Server } from "@s2script/sdk/server";
import { Bans } from "@s2script/sdk/bans";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { cfg, n, s } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { KarmaEvent, TttEvents } from "../core/events";
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

/**
 * The bench, mirrored by SteamID. The C# held `Dictionary<IPlayer, int> cooldownRounds` and
 * `Dictionary<IPlayer, DateTime> lastWarned`, and `IPlayer` equality is SteamID equality — so a
 * sit-out and the 24h warning window follow the *person*: they survive a reconnect and they never
 * land on whoever inherits the freed slot. The live tables above stay slot-indexed because
 * `roleAssign` reads them for every player of every round; these two Maps are touched only on
 * connect and disconnect.
 */
const benchRounds = new Map<string, number>();
const benchWarned = new Map<string, number>();

/**
 * One-shot "this death costs nobody karma" flags, indexed by VICTIM slot — the port of
 * `KarmaUpdateManager.IgnoreEvent`. The C# generic ignore machinery (ignored reasons, ignored
 * source events, arbitrary predicates) has exactly one caller in the entire tree: the tripwire's
 * "an old trap is not your fault" forgiveness. One byte per slot expresses that with none of the
 * bookkeeping.
 */
const suppressKill = new Uint8Array(MAX_SLOTS);

let bus: EventBus<TttEvents>;

/**
 * The karma the credit scale treats as full — the C# `KarmaConfig.MaxKarma()`. NOT a stored
 * ceiling: karma is written verbatim and regulars really do drift past this.
 */
export const MAX_KARMA = 100;

/**
 * The shipped default of `css_ttt_karma_low_command` (src/core/cvars.ts), verbatim.
 *
 * It names `sm_ban`, which a bare s2script server does not implement (the C# shipped the
 * CounterStrikeSharp spelling `css_ban` for the same reason: on *their* runtime it existed). Leaving
 * the cvar untouched therefore has to mean "eject them", not "run a console line that resolves to
 * nothing" — which is what {@link punishLowKarma} keys off. Kept in sync with cvars.ts by hand;
 * a mismatch only costs the built-in fallback, it cannot misfire the operator's own command.
 */
const STOCK_LOW_KARMA_COMMAND = "sm_ban #{0} 2880 Low Karma";

/** Minutes the built-in ban fallback bans for — the duration baked into {@link STOCK_LOW_KARMA_COMMAND}. */
const LOW_KARMA_BAN_MINUTES = 2880;

/** Reason shown for the built-in low-karma ban/kick — the reason baked into the stock command. */
const LOW_KARMA_REASON = "Low Karma";

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
  // Deliberately UNCLAMPED, at both ends. `KarmaStorageKV.Write` stores the value verbatim, and
  // that is what makes the low-karma branch reachable at all: a bad-kill spree pushes karma below
  // zero inside a single round, and `karma < MinKarma` (default 0) is what triggers the ban and the
  // reset to the default. Clamping at 0 turns that test into `0 < 0` and quietly deletes the
  // harshest consequence in the mode. The 100 end matters too — `MaxKarma()` is only ever read as
  // the credit-scale divisor, so a veteran is *supposed* to bank a buffer above the sit-out
  // threshold instead of saturating with everyone else.
  const rounded = Math.round(value);
  // Resolved BEFORE the dispatch, not after. A `karma` listener may eject the player (the low-karma
  // branch of `enforce`), and a kick that lands synchronously runs `reg.removePlayer`, which blanks
  // `steamIds[slot]` — reading the id afterwards would silently drop the write to `persisted` and
  // leave the offender's stored karma negative, so the ban would re-fire on their next update. The
  // slot's identity for THIS write is fixed at call time.
  const id = reg.steamIdOf(slot);
  const ev = bus.emit("karma", { slot, oldKarma: old, karma: rounded, canceled: false });
  if (ev.canceled) return;

  karma[slot] = ev.karma;
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
    // Cleared BEFORE the write, not with a fill() afterwards: setKarma can re-enter this table via
    // the low-karma branch (which ejects the player, and the `leave` handler settles whatever is
    // still owed), and a delta left sitting here would then be paid twice.
    pending[slot] = 0;
    setKarma(slot, karma[slot]! + delta);
  }
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
  // Drop the SteamID copy as well, or the bench an admin just lifted would come straight back the
  // next time that player reconnects.
  const id = reg.steamIdOf(slot);
  if (id !== "") {
    benchRounds.delete(id);
    benchWarned.delete(id);
  }
}

/**
 * Forgive the karma consequences of `victim`'s next death — the port of
 * `IKarmaUpdateManager.IgnoreEvent`. Consumed by the death that follows, whichever way that death
 * is scored.
 */
export function suppressKarmaOnce(victim: number): void {
  if (victim >= 0 && victim < MAX_SLOTS) suppressKill[victim] = 1;
}

/** Mirror a slot's sit-out onto its SteamID so it survives the disconnect. */
function stashBench(slot: number): void {
  const id = reg.steamIdOf(slot);
  // Bots and half-connected clients have no identity to key on, so there is nothing to carry.
  if (id === "" || id === "0") return;
  const rounds = timeoutRounds[slot]!;
  const warned = lastWarned[slot]!;
  if (rounds <= 0 && warned === 0) {
    benchRounds.delete(id);
    benchWarned.delete(id);
    return;
  }
  benchRounds.set(id, rounds);
  benchWarned.set(id, warned);
}

/**
 * Bank a departing player's outstanding karma WITHOUT going through {@link setKarma}.
 *
 * This is the one write that must not dispatch `karma`. In C# a quitter's queued deltas sit in
 * `KarmaUpdateManager.updateQueue` until `KarmaListener.OnRoundEnd` flushes them, and by then
 * `KarmaBanner.issueKarmaBan`'s `converter.GetPlayer(player) == null` is true — so a departed
 * offender is neither ejected nor reset to the default, and their negative karma is still waiting
 * for them when they come back. Here `leave` is emitted from inside `ctx.clients.onDisconnect`,
 * where `Player.fromSlot(slot)` still resolves, so dispatching would take the branch C# never
 * takes: a 48h ban plus a reset for someone who is already gone.
 *
 * The sit-out half of the flush still applies — `issueKarmaWarning` records against the SteamID —
 * so it is called directly, and only above the ban floor, since `OnKarmaUpdate` returns before it.
 */
function settleOnLeave(slot: number, value: number): void {
  const settled = Math.round(value);
  karma[slot] = settled;
  const id = reg.steamIdOf(slot);
  if (id !== "" && id !== "0") persisted.set(id, settled);
  // No setScore: the scoreboard entry of a client the engine is tearing down goes with it.
  if (settled >= cfg.karmaMin) benchLowKarma(slot, settled);
}

/**
 * Wipe every per-player table for a slot that is changing hands.
 *
 * The C# never needed this: its state was keyed by SteamID, so a slot carried nothing. Here the
 * next occupant would otherwise inherit the previous one's sit-out (they get dealt Spectator for up
 * to four rounds on a full 50 karma), their round-end penalty, their bad-kill multiplier and their
 * side of the first-damage matrix. The 64-iteration matrix scrub only runs on connect/disconnect.
 */
function clearSlotState(slot: number): void {
  timeoutRounds[slot] = 0;
  lastWarned[slot] = 0;
  pending[slot] = 0;
  badKills[slot] = 0;
  suppressKill[slot] = 0;
  for (let i = 0; i < MAX_SLOTS; i++) {
    firstDamage[slot * MAX_SLOTS + i] = 0;
    firstDamage[i * MAX_SLOTS + slot] = 0;
  }
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
  // C# only clears its ignore set after a queue flush, so an entry nobody consumed lives forever —
  // harmless there because it holds unique event references, but here it is a per-victim byte that
  // would forgive an unrelated death later on. The round boundary bounds its lifetime.
  suppressKill.fill(0);
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
  // Read-and-clear the one-shot suppression up front: the flag belongs to THIS death, so every exit
  // below has to consume it or it would silently forgive the victim's next one instead.
  const suppressed = suppressKill[victim] === 1;
  suppressKill[victim] = 0;

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

  // Suppression drops the deltas, not the whole scoring pass. `IgnoreEvent` only filters updates as
  // the queue drains; `OnKill` has already run by then and has already bumped the killer's bad-kill
  // count — so a forgiven old-trap teamkill still raises the multiplier on their next bad kill.
  if (suppressed) return;

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
 * Eject a player whose karma fell through the floor, the way `KarmaBanner.issueKarmaBan` does.
 *
 * Three cases, and the gate is on WHICH command is configured rather than on whether one is:
 *
 * - **Blank** — nothing happens. `issueKarmaBan` runs `string.Format(CommandUponLowKarma, userId)`
 *   unconditionally, so an empty setting executes an empty console line, i.e. a no-op. Clearing the
 *   cvar is the only "turn punishment off" switch the C# offers and it keeps working here.
 * - **The untouched default** — the SDK ban store, because {@link STOCK_LOW_KARMA_COMMAND} names a
 *   command this runtime does not have. Without this the whole branch is a no-op on a default
 *   install: karma below the floor would eject nobody. `Bans.add` only *records* the ban
 *   (enforcement is a connect-time check owned by a ban plugin), so the kick is issued here too.
 * - **Anything the operator wrote** — authoritative and exclusive. They asked for that command; a
 *   built-in ban on top of it would be a second, unrequested punishment.
 *
 * The reset to the default karma is NOT done here — it is a rewrite of the in-flight event, see
 * {@link enforce}.
 */
function punishLowKarma(slot: number, player: Player): void {
  // Read the LIVE ConVar, not the config snapshot. `refresh()` maps an empty ConVar back to the
  // registered default for every kind (core/cvars.ts), so an operator who deliberately clears this
  // to switch punishment OFF would read back the stock ban command and get banned anyway — the
  // exact inversion of what they asked for. `Server.getCvar` returns "" only when it is genuinely
  // cleared, which is the same "do nothing" the C# gets from `string.Format("", userId)`.
  const command = Server.getCvar("css_ttt_karma_low_command");
  if (command === "") return;

  if (command !== STOCK_LOW_KARMA_COMMAND) {
    // The command is operator-authored config; the user id is an engine integer, so there is no
    // untrusted text in the console string.
    Server.command(command.replace("{0}", String(player.userId)));
    return;
  }

  const id = reg.steamIdOf(slot);
  if (id !== "" && id !== "0") Bans.add(id, LOW_KARMA_BAN_MINUTES, LOW_KARMA_REASON);
  player.kick(LOW_KARMA_REASON);
}

/**
 * Enforce the low-karma consequences: below the ban floor ejects the player and resets them to the
 * default karma; below the timeout threshold benches them for a few rounds (with a rate-limited
 * warning).
 *
 * Takes the live event because the reset has to be a rewrite of it — see below.
 */
function enforce(ev: KarmaEvent): void {
  const slot = ev.slot;

  if (ev.karma < cfg.karmaMin) {
    // C# resolves the controller first and bails when the player has already left, so a
    // disconnected offender is neither punished nor reset — the negative karma is still waiting for
    // them when they come back.
    const player = Player.fromSlot(slot);
    if (player === null) return;
    // The reset REWRITES the in-flight event rather than calling setKarma() again. We are inside
    // the dispatch that setKarma is about to read back from, so a nested write would be undone by
    // the outer `karma[slot] = ev.karma` a moment later and the offender would stay negative,
    // re-firing the ban command at every round end. C# reaches the same net stored value the long
    // way round, by deferring the DefaultKarma write to a later frame.
    //
    // Rewritten BEFORE the eject so the ordering is not load-bearing: whether or not the kick
    // re-enters this module synchronously, the value setKarma stores is already the final one.
    ev.karma = cfg.karmaDefault;
    punishLowKarma(slot, player);
    return;
  }

  // `return` above, exactly as `OnKarmaUpdate` does: a player who fell through the ban floor is
  // never *also* benched.
  benchLowKarma(slot, ev.karma);
}

/**
 * The sit-out half of `KarmaBanner.OnKarmaUpdate` — `issueKarmaWarning`, behind its warning window.
 *
 * Split out of {@link enforce} because it is the only half that still applies to a player who has
 * already left: `cooldownRounds`/`lastWarned` are keyed by `IPlayer`, i.e. by SteamID, so a quitter
 * whose settled karma lands under the threshold is still benched for their return.
 */
function benchLowKarma(slot: number, value: number): void {
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
    // Deliberately NOT gated on `ev.canceled`. `OnHurt` carries a bare [EventHandler], and the C#
    // bus skips a handler only when it opts in with `IgnoreCanceled` — so a hit nullified by the
    // Taser or by friendly-fire blocking still puts the attacker on record as the aggressor. Bail
    // out on that flag and being tased stops counting as "they shot first", which flips the guilty
    // verdict (and the karma either way) on every kill that follows. The round-state test is the
    // guard `OnHurt` actually has; it is also what the out-of-round canceler was standing in for.
    if (ev.attacker < 0 || game.state !== GameState.InProgress) return;
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

  eventBus.on("karma", enforce, { priority: Priority.MONITOR, ignoreCanceled: true });

  eventBus.on("join", (ev) => {
    const slot = ev.slot;
    const id = reg.steamIdOf(slot);
    loadKarma(slot, id);
    // Restore unconditionally instead of only when the maps hold an entry: `reg.syncRoster` drops
    // players at every round boundary WITHOUT emitting `leave` (bots never fire the client
    // lifecycle callbacks at all), so this is also the backstop that stops a recycled slot handing
    // the previous occupant's bench to a newcomer.
    clearSlotState(slot);
    timeoutRounds[slot] = benchRounds.get(id) ?? 0;
    lastWarned[slot] = benchWarned.get(id) ?? 0;
  });

  eventBus.on("leave", (ev) => {
    const slot = ev.slot;
    // Settle what this round already owed them before the slot changes hands. C# queues updates
    // against an IPlayer — a SteamID — so a mid-round disconnect still lands on their stored karma;
    // dropping the delta here would make quitting early a way to dodge an RDM penalty, and leaving
    // it queued would charge it to whoever takes the slot next.
    const owed = pending[slot]!;
    pending[slot] = 0;
    if (owed !== 0) settleOnLeave(slot, karma[slot]! + owed);

    // After the settle, so a sit-out that delta just earned them is the one that gets carried.
    stashBench(slot);
    clearSlotState(slot);
  });
}
