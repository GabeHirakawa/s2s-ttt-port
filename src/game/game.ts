/**
 * The round state machine — the port of `IGame` / `RoundBasedGame` / `CS2Game` / `GameManager`.
 *
 * Two structural changes from the C#:
 *
 * 1. **The win check is O(1).** `RoundBasedGame.getWinningTeam` walked every player, called
 *    `RoleAssigner.GetRoles(p)` (a SteamID-string dictionary probe returning a fresh collection) and
 *    ran `Any(r => r is TraitorRole)` — a runtime type test per role per player. It ran on every
 *    death, every disconnect, and from a 1 Hz safety timer. Here the registry keeps live per-role
 *    alive counters, so the whole check is three integer reads.
 *
 * 2. **There is one game object, reused.** The original allocated a fresh `RoundBasedGame` per
 *    round — which re-instantiated every `IRole` (each pulling ~6 services out of the DI container)
 *    and a fresh logger. Rounds here mutate module state and reset it.
 */

import { delay } from "@s2script/sdk/timers";
import { Server } from "@s2script/sdk/server";
import { GameRules, RoundEndReason, Teams } from "@s2script/cs2";
import { GameState, RoleId, Team } from "../core/enums";
import { cfg, refresh, roundDuration } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { assignRoles, revealTraitorBuddies, roleName } from "./roles";
import { clearLog, printLogs } from "./logger";
import { clearBodies } from "../cs2/bodies";
import { isPlayingTeam, respawn, setPawnIsAlive, tellAll } from "../cs2/pawn";
import { resetTeamsToT, revealAllRoles } from "./teams";
import { setSpoofingEnabled } from "../cs2/spoof";

/** Live round state. A module singleton — there is exactly one round in flight. */
export const game = {
  state: GameState.Waiting as GameState,
  /** Role that won, or {@link RoleId.None} for a draw / non-role end. */
  winner: RoleId.None as RoleId,
  /** `Server.gameTime` when the round went live. */
  startedAt: 0,
  /** How many players were dealt a playing role. */
  participants: 0,
  /** Rounds completed since the map loaded — the special-round gate reads this. */
  roundsThisMap: 0,
};

let bus: EventBus<TttEvents>;
/** Monotonic token invalidating in-flight timers when the round moves on. */
let epoch = 0;

/**
 * One-shot: set when the ENGINE ended (or restarted) the round instead of TTT. Consumed by the next
 * {@link endGame}, which then skips its own `terminateRound` — the engine's restart is already in
 * flight and a second terminate landing on top of it cuts the round that is starting short.
 */
let engineEndedRound = false;

/**
 * Seconds to wait past the round-end terminate for the engine's `round_start` before giving up on
 * it. The terminate asks for a 3s pre-restart delay, so anything beyond this is a stuck round
 * rather than a slow one.
 */
const FINISHED_TIMEOUT = 10;

/** Wire the module to the plugin's bus. Call once from the factory. */
export function initGame(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;
}

/**
 * Move to `next`, giving listeners a chance to veto. Returns false if a listener canceled.
 * Mirrors the C# `State` setter, which dispatched `GameStateUpdateEvent` on every write.
 */
export function setState(next: GameState): boolean {
  const ev = bus.emit("gameState", { state: next, canceled: false });
  if (ev.canceled) return false;
  game.state = next;
  return true;
}

/** Is a round currently being played? */
export function inProgress(): boolean {
  return game.state === GameState.InProgress;
}

/** How many players are eligible to play right now (on a team and alive). */
function eligible(out: number[]): number[] {
  out.length = 0;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (reg.isAlive(slot)) out.push(slot);
  }
  return out;
}

const poolBuffer: number[] = [];
/** Scratch list of slots `syncRoster` newly discovered. */
const addedBuffer: number[] = [];

/**
 * Reconcile the roster and fire `join` for anyone newly discovered.
 *
 * Bots never fire `ctx.clients.onActive`, so this is the path by which a bot-populated server gets
 * its per-player state (karma especially) initialised at all.
 */
export function syncRosterAndAnnounce(): void {
  if (!reg.syncRoster(addedBuffer)) return;
  for (let i = 0; i < addedBuffer.length; i++) bus.emit("join", { slot: addedBuffer[i]! });
}

/** True while the engine is in its warmup period, during which TTT will not start a round. */
export function inWarmup(): boolean {
  return GameRules.get()?.warmupPeriod === true;
}

/**
 * Begin a round: countdown, then deal roles. Safe to call from any handler — it is idempotent
 * against the current state.
 *
 * @param quiet - suppress the "not enough players" announcement. The idle poller passes true so it
 *   does not spam chat every couple of seconds on an empty server.
 */
export function startGame(quiet = false): void {
  if (game.state !== GameState.Waiting) return;

  // Warmup is a hard block, not a failure: the idle poller and `warmup_end` both retry, so a
  // server that boots into warmup starts its first TTT round the moment warmup finishes.
  if (inWarmup()) return;

  // The roster is reconciled against the engine here rather than trusted from client events —
  // bots never fire `onActive`, so an event-only roster is empty on a bot-populated server.
  syncRosterAndAnnounce();
  if (reg.playerCount() < cfg.minPlayers) {
    if (!quiet) tellAll(msg("NOT_ENOUGH_PLAYERS", cfg.minPlayers));
    return;
  }

  refresh(); // pick up any ConVar edits made since the last round

  if (!setState(GameState.Countdown)) return;
  tellAll(msg("GAME_STATE_STARTING", cfg.countdownSeconds));

  const mine = ++epoch;
  GameRules.get()?.setTimeRemaining(cfg.countdownSeconds + 5);
  Server.command("mp_ignore_round_win_conditions 1");

  // Put everyone back on T as the countdown OPENS, not just from the 1 Hz countdown ticker: last
  // round's revealed Innocents are still sitting on CT, and the ticker is not guaranteed to run
  // before roles are dealt (a one-second countdown, or a frame the shared handler dropped because
  // `dt > 1`). Whoever joins or gets revealed later is caught by the ticker as before.
  resetTeamsToT();

  // Everyone on a playing team but currently dead gets put back in play for the coming round.
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot) && isPlayingTeam(slot)) respawn(slot);
  }

  void delay(cfg.countdownSeconds * 1000).then(() => {
    if (mine !== epoch || game.state !== GameState.Countdown) return;
    beginRound();
  });
}

/** Deal roles and go live. */
function beginRound(): void {
  reg.resyncAlive();
  const pool = eligible(poolBuffer);

  if (pool.length < cfg.minPlayers) {
    tellAll(msg("NOT_ENOUGH_PLAYERS", cfg.minPlayers));
    setState(GameState.Waiting);
    return;
  }

  reg.rotateRoles();
  setSpoofingEnabled(true);
  clearBodies(true);
  clearLog();
  for (let i = 0; i < pool.length; i++) reg.refreshName(pool[i]!);

  game.winner = RoleId.None;
  game.startedAt = Server.gameTime;
  // `assignRoles` consumes `pool` in place (swap-and-pop); that is fine, it is rebuilt each round.
  game.participants = assignRoles(bus, pool);

  // Arm the default round clock BEFORE the InProgress dispatch, not after. `setState` runs its
  // listeners synchronously, and one of them (the Speed special round) re-arms the deadline with a
  // much shorter clock from inside that dispatch. Arming afterwards would bump `epoch` again and
  // silently replace Speed's timer with the full-length one — the announcement would fire and the
  // round would then play out as a normal one. The C# hit the same race deliberately from the other
  // side: `SpeedRound.ApplyRoundEffects` disposed `RoundTimerListener.EndTimer` and scheduled its
  // own, so whoever arms last wins and it made sure that was Speed.
  setRoundDeadline(roundDuration(game.participants));

  if (!setState(GameState.InProgress)) return;

  const traitors = reg.aliveCount(RoleId.Traitor);
  const nonTraitors = game.participants - traitors;
  tellAll(msg("GAME_STATE_STARTED", traitors === 1 ? "is" : "are", traitors, nonTraitors));
  revealTraitorBuddies();
}

/**
 * (Re)arm the round timer for `seconds` from now, and sync the HUD clock to match.
 *
 * Exposed so the Speed special round can shorten and then extend the round — the C# achieved this
 * by reaching into `RoundTimerListener.EndTimer` and disposing another module's Rx subscription.
 */
export function setRoundDeadline(seconds: number): void {
  GameRules.get()?.setTimeRemaining(Math.ceil(seconds));
  const mine = ++epoch;
  void delay(seconds * 1000).then(() => {
    if (mine !== epoch || game.state !== GameState.InProgress) return;
    endGame(RoleId.Innocent, "Round ended due to timeout");
  });
}

/**
 * Decide whether the round is over and end it if so.
 *
 * The counters this reads are maintained incrementally by the registry, so this is safe to call as
 * often as you like — the C# equivalent was expensive enough that its 1 Hz safety timer was a real
 * cost, and it is kept here (as a cheap poll) only as a convergence guarantee.
 */
export function checkEndConditions(): boolean {
  if (game.state !== GameState.InProgress) return false;

  const traitors = reg.aliveCount(RoleId.Traitor);
  const innocents = reg.aliveCount(RoleId.Innocent);
  const detectives = reg.aliveCount(RoleId.Detective);
  const nonTraitors = innocents + detectives;

  if (traitors === 0 && nonTraitors === 0) {
    endGame(RoleId.None, "Draw");
    return true;
  }
  if (traitors > 0 && nonTraitors === 0) {
    endGame(RoleId.Traitor);
    return true;
  }
  if (traitors === 0 && nonTraitors > 0) {
    endGame(RoleId.Innocent);
    return true;
  }
  // Only detectives left alive on the non-traitor side: the detectives take it.
  if (traitors > 0 && innocents === 0 && detectives > 0 && nonTraitors === detectives) {
    // The original ended here too, but only when *every* surviving non-traitor is a detective —
    // which is what `innocents === 0` already means. Traitors are still alive, so this is a
    // detective win only in the original's sense; keep the behaviour identical.
    endGame(RoleId.Detective);
    return true;
  }
  return false;
}

/** End the round with `winner` (or {@link RoleId.None} plus a `reason` for a non-role end). */
export function endGame(winner: RoleId, reason?: string): void {
  if (game.state !== GameState.InProgress && game.state !== GameState.Countdown) return;

  // Consume the flag here rather than reading it from the timer below, and consume it even if the
  // transition is vetoed: a flag left standing would suppress the terminate of some later round
  // that TTT itself decided.
  const engineDriven = engineEndedRound;
  engineEndedRound = false;

  game.winner = winner;
  epoch++; // invalidate the round timer
  if (!setState(GameState.Finished)) return;

  tellAll(
    winner === RoleId.None
      ? msg("GAME_STATE_ENDED_OTHER", reason ?? "Unknown")
      : msg("GAME_STATE_ENDED_TEAM_WON", roleName(winner)),
  );

  revealRoles();
  printLogs();
  game.roundsThisMap++;

  const endReason =
    winner === RoleId.Traitor ? RoundEndReason.TerroristsWin : RoundEndReason.CTsWin;
  if (winner !== RoleId.None) {
    Teams.addScore(winner === RoleId.Traitor ? Team.Terrorist : Team.CounterTerrorist, 1);
  }

  const mine = ++epoch;
  void delay(cfg.timeBetweenRounds * 1000).then(() => {
    if (mine !== epoch) return;
    // When the ENGINE ended this round its own restart is already pending (mp_round_restart_delay),
    // so terminating again here would cut the restarting round short a second or two in.
    if (engineDriven) return;
    Server.command("mp_ignore_round_win_conditions 1");
    GameRules.terminateRound(endReason, 3);
    Server.command("mp_ignore_round_win_conditions 0");
  });

  // Watchdog on FINISHED. Nothing inside TTT drives the round forward from here: the next round is
  // started by the engine's `round_start` landing after the terminate above, and FINISHED is the
  // one state no ticker services (`tickWaiting` and `tickCountdown` both bail on it). If that
  // restart never arrives — a terminate the engine dropped, an admin freezing the round, a map
  // running its own round logic — the mode deadlocks with everyone stood in the end-of-round
  // reveal forever. Fall back to WAITING and let the idle poller take it from there.
  void delay((cfg.timeBetweenRounds + FINISHED_TIMEOUT) * 1000).then(() => {
    // Any legitimate restart moves the state on (and `startGame` bumps `epoch`), so a live token
    // AND a still-FINISHED state together mean the restart really is never coming.
    if (mine !== epoch || game.state !== GameState.Finished) return;
    returnToWaiting();
  });
}

/**
 * The ENGINE ended the round rather than TTT — an admin `endround`/`mp_restartgame`, a
 * `Game_Commencing`, a map entity, or an operator config that cleared
 * `mp_ignore_round_win_conditions` and let a win condition through.
 *
 * The engine treats its own round end as final and restarts the round, respawning everyone: the
 * dead come back with last round's roles, corpses stay on the ground, and the alive counters the
 * win check reads stop converging — the round would hang until the deadline timer fired minutes
 * later. So TTT folds its round up behind the engine, exactly as `RoundEnd_GameEndHandler` did
 * (whose `FinishedAt == null` test is this function's state guard: an end TTT caused itself has
 * already moved the state off InProgress by the time the engine's `round_end` lands).
 */
export function onEngineRoundEnd(): void {
  if (game.state !== GameState.InProgress) return;
  engineEndedRound = true;
  endGame(RoleId.Innocent);
}

/** Drop back to WAITING and queue the next round if the server is populated enough for one. */
function returnToWaiting(): void {
  game.state = GameState.Waiting;
  syncRosterAndAnnounce();
  reg.resyncAlive();
  if (reg.playerCount() >= cfg.minPlayers) startGame();
}

/**
 * Reveal every participant's role on the scoreboard and put revealed Innocents onto CT so the win
 * panel reads correctly. `switchTeam` is the non-lethal move — `changeTeam` would kill them.
 */
function revealRoles(): void {
  // Stop the alive-spoofer first: it re-asserts "alive" every frame, and would immediately undo
  // the real liveness written just below.
  setSpoofingEnabled(false);
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const role = reg.roleOf(slot);
    if (role === RoleId.None || role === RoleId.Spectator) continue;
    setPawnIsAlive(slot, reg.isAlive(slot));
  }
  revealAllRoles();
}

/**
 * Called when the engine's own round actually restarts. Resets to Waiting and, if enough players
 * are present, immediately queues the next TTT round.
 */
export function onEngineRoundStart(): void {
  // A `round_start` arriving while TTT still has a live round is proof the engine restarted it out
  // from under us, and it covers the restarts that never fire `round_end` at all. Everyone has just
  // been respawned with last round's roles, so the round cannot be salvaged — fold it up the way an
  // engine round end would, suppressing the follow-up terminate since the restart already happened.
  if (game.state === GameState.InProgress) {
    engineEndedRound = true;
    endGame(RoleId.Innocent);
  }

  // FINISHED (including the end just above) or an idle WAITING: a fresh engine round, so reset and
  // queue the next TTT one. A COUNTDOWN is deliberately left to run — its 1 Hz ticker already
  // respawns, re-teams and re-syncs liveness every second, so an engine restart underneath it
  // resolves itself without throwing the countdown away.
  if (game.state === GameState.Finished || game.state === GameState.Waiting) returnToWaiting();
}

/**
 * While counting down, keep pulling dead players on a playing team back into the world.
 *
 * `startGame` respawns once when the countdown opens, but anyone who connects (or finishes
 * spawning) during the countdown would otherwise still be dead at `beginRound` and get skipped —
 * `eligible()` only deals roles to the living. Respawns are queued a frame out, so doing this
 * repeatedly through the countdown is what actually gets them in.
 */
let countdownAccum = 0;
export function tickCountdown(dt: number): void {
  if (game.state !== GameState.Countdown) {
    countdownAccum = 0;
    return;
  }
  countdownAccum += dt;
  if (countdownAccum < 1) return;
  countdownAccum = 0;

  syncRosterAndAnnounce();
  // Everyone starts the round on T so team membership gives nothing away; the Detective is moved
  // to CT when roles are dealt. Done through the countdown rather than once, so a late joiner or a
  // player revealed last round is still put back before assignment.
  resetTeamsToT();
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (reg.isAlive(slot)) continue;
    if (isPlayingTeam(slot)) respawn(slot);
  }
  reg.resyncAlive();
}

/**
 * Idle poller: try to start a round while sitting in WAITING.
 *
 * TTT cannot rely on `round_start` to bootstrap. It sets `mp_ignore_round_win_conditions 1` so the
 * engine never decides a round — which also means the engine never *restarts* one on its own. If
 * TTT is in WAITING (a fresh load, a hot reload, or a round that could not start for want of
 * players), nothing would ever fire `round_start` again and the mode would deadlock. Polling here
 * makes starting a round depend only on TTT's own state.
 */
let waitingAccum = 0;
export function tickWaiting(dt: number): void {
  if (game.state !== GameState.Waiting) {
    waitingAccum = 0;
    return;
  }
  waitingAccum += dt;
  if (waitingAccum < 2) return;
  waitingAccum = 0;
  startGame(true);
}

/** A map changed under us: abandon any live round. */
export function onMapChange(): void {
  clearBodies(false);
  if (game.state === GameState.InProgress || game.state === GameState.Countdown) {
    endGame(RoleId.None, "Map Change");
  }
  game.state = GameState.Waiting;
  // Zero the counter AFTER the round is folded up, not before: `endGame` increments it, and the
  // round it is counting was played on the map being left. Resetting first handed the new map that
  // abandoned round, so `css_ttt_special_min_rounds_after_map` (read as `roundsThisMap < n`) came
  // due one full round early after every map change.
  game.roundsThisMap = 0;
  // Bump LAST, not first. `endGame` arms its own timers (the round-end terminate and the FINISHED
  // watchdog) against a fresh token, so a bump taken before it invalidates only the timers of the
  // round that is already over and leaves those two live — they would then fire into the new map,
  // terminating its opening round a second after it loads and forcing a round start on top.
  epoch++;
}
