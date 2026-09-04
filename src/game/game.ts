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
import { bindRoundEpoch, nextPreFrame } from "../core/preframe";
import { Server } from "@s2script/sdk/server";
import { Events, GameRules, RoundEndReason, Teams, WinPanelFinalEvent } from "@s2script/cs2";
import { GameState, MAX_SLOTS, RoleId, Team } from "../core/enums";
import { cfg, refresh, roundDuration } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { assignRoles, revealTraitorBuddies, roleName, stripRoundWeapons } from "./roles";
import { clearLog, printLogs } from "./logger";
import { owedBy } from "../rdm/sanctions";
import { clearBodies } from "../cs2/bodies";
import {
  getHealth, isPlayingTeam, pawnOf, respawn, restoreFullHealth, setPawnIsAlive, teamOf, tellAll,
} from "../cs2/pawn";
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

/**
 * The engine's own respawn permission.
 *
 * `CCSPlayerController::Respawn` HONOURS the gamemode's respawn rules: with these off it silently
 * no-ops, leaving the controller holding a pawn that was built but never placed in the world
 * (`lifeState = LIFE_DEAD`, `health = 100`). Measured on a live server — `respawn()` reported success
 * once a second for a whole 15-second countdown while the player stayed dead on the floor, and only
 * players spawned by the ENGINE's own round restart (which obeys no such rule) ever came alive. That
 * is why "you had to be connected before the round ended" to get spawned.
 *
 * So TTT owns the setting rather than leaving it to the config, and it MUST be a toggle: left on, a
 * player who dies mid-round respawns instantly, which is the one thing this mode cannot allow.
 *
 * ON for WAITING/COUNTDOWN, so everyone can be put into the world. OFF the moment the round goes
 * live, so death is permanent.
 */
function setEngineRespawnAllowed(on: boolean): void {
  // `Server.setCvar`, not `Server.command`. A console command is queued to the next frame, so
  // every caller's "set this BEFORE the respawn loop / BEFORE roles are dealt" comment was false
  // at runtime — the write landed a frame after the thing it was supposed to gate. Since core #108
  // setCvar writes ConVarData directly, so getCvar and onCvarChange see it before this returns.
  const v = on ? "1" : "0";
  if (!Server.setCvar("mp_respawn_on_death_t", v)) console.log("[ttt] WARN: mp_respawn_on_death_t rejected");
  if (!Server.setCvar("mp_respawn_on_death_ct", v)) console.log("[ttt] WARN: mp_respawn_on_death_ct rejected");
}

/** Wire the module to the plugin's bus. Call once from the factory. */
export function initGame(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;
  bindRoundEpoch(roundEpoch);
}

/** Current round-timer generation. Pre-frame jobs and delay hops stamp this. */
export function roundEpoch(): number {
  return epoch;
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

/**
 * How many players are eligible to play right now (on a team, alive, and not serving a sanction).
 *
 * SANCTIONED PLAYERS ARE EXCLUDED FROM THE ROLE POOL RATHER THAN PUNISHED INSIDE IT. A player who
 * owes an RDM slay is about to be killed at the round start either way, and the alternative — deal
 * them a role and then slay them — is strictly worse in two ways. A slain Traitor hands the round
 * to the Innocents through no fault of anyone playing it, and a slain Detective removes the role
 * the mode leans on hardest. Either turns one player's punishment into everybody's round.
 *
 * Leaving them out of the count as well is deliberate: they are not participating, so counting them
 * toward `minPlayers` would start rounds that are a player short of what the operator asked for.
 */
function eligible(out: number[]): number[] {
  out.length = 0;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    if (owedBy(reg.steamIdOf(slot)) > 0) continue;
    out.push(slot);
  }
  return out;
}

/** Frames `beginRound` will wait for spawns to land before starting without them. */
const SPAWN_SETTLE_FRAMES = 4;

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
  // EXACTLY the countdown, with nothing added. This used to be `countdownSeconds + 5`, which put the
  // HUD clock five seconds ahead of the thing it was counting down to: the round went live with the
  // clock reading 0:05 and players learned to ignore it. The engine cannot end the round when this
  // reaches zero — `mp_ignore_round_win_conditions 1` is set on the very next line — and `beginRound`
  // re-arms the clock with the round length in the same instant the countdown expires.
  GameRules.get()?.setTimeRemaining(cfg.countdownSeconds);
  Server.setCvar("mp_ignore_round_win_conditions", "1");

  // Put everyone back on T as the countdown OPENS, not just from the 1 Hz countdown ticker: last
  // round's revealed Innocents are still sitting on CT, and the ticker is not guaranteed to run
  // before roles are dealt (a one-second countdown, or a frame the shared handler dropped because
  // `dt > 1`). Whoever joins or gets revealed later is caught by the ticker as before.
  // BEFORE the respawn loop below: the engine refuses a respawn while this is off, so enabling it
  // afterwards would let the first batch of spawns be silently dropped.
  setEngineRespawnAllowed(true);

  resetTeamsToT();

  // Everyone on a playing team but currently dead gets put back in play for the coming round.
  // Copied, and re-checked per iteration: `activeSlots()` hands back the registry's live
  // backing array, and since core #108 the outbound call in this loop runs other plugins'
  // handlers before it returns — one of which can disconnect a player and splice this array
  // mid-walk. That shifts every later element left, silently skipping someone.
  // Re-read liveness from the ENGINE before deciding who to respawn.
  //
  // `reconcileRound` only resyncs while the round is IN_PROGRESS, so nothing refreshes the registry
  // across Finished -> Waiting -> Countdown. A round that ended because the Traitors wiped the
  // server leaves the registry holding whatever it last believed, and anyone it wrongly thinks is
  // alive is skipped here and starts the next round as a corpse. The C# never had this failure mode
  // because it asks the engine directly (`p.GetHealth() <= 0`), which is what the loop below now
  // does — the registry is a cache, and a cache is the wrong thing to ask whether someone is dead.
  reg.resyncAlive();
  const active = reg.activeSlots().slice();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isConnected(slot)) continue;
    if (isPlayingTeam(slot) && getHealth(slot) <= 0) respawn(slot);
  }

  void delay(cfg.countdownSeconds * 1000).then(() => {
    // Timer wakes in POST; world mutation waits for the next PRE.
    nextPreFrame(() => {
      if (mine !== epoch || game.state !== GameState.Countdown) return;
      beginRound();
    });
  });
}

/**
 * How many extra frames {@link beginRound} will wait for a queued respawn to land.
 *
 * `Player.respawn` takes effect a frame or two later, so a player respawned in the same breath as the
 * liveness check still reads as dead. Excluding them was the wrong answer — someone who connected
 * during the countdown must be ALIVE when the round starts, not benched for arriving late. Waiting a
 * few frames is imperceptible (~50ms at 64 tick) and is the difference between "we asked the engine
 * to spawn them" and "they are actually in the round".
 */

/**
 * Deal roles and go live.
 *
 * The invariant: EVERY player dealt a role is alive at the moment the round goes live. Anyone on a
 * playing team who is still dead is respawned first, and because an outbound call now completes
 * before it returns, that spawn has either landed or been refused by game rules by the time roles
 * are dealt — no waiting, no retry window.
 */
function beginRound(attempt = 0): void {
  reg.resyncAlive();

  // Respawn anyone on a playing team who is still dead. The countdown ticker already tries this every
  // second, but it is best-effort: a player who connected in the last second, or died in it, reaches
  // here dead — and dealing a role to a dead player produced a round whose participants were lying on
  // the floor before it began, Traitors included, which the win check counts and nobody can kill.
  // One sweep, then read the truth. There is no settle loop any more.
  //
  // `respawn()` used to be queued to a nextFrame drain, so this function could only count spawns
  // it had ASKED for and then re-enter itself over four frames hoping they landed. Since core #108
  // an outbound call completes — and runs every other plugin's handlers — before it returns, so
  // `resyncAlive()` immediately after the sweep reads the real world. Retrying bought nothing
  // anyway: a spawn refused by game rules on one frame is refused identically on the next four,
  // and each re-entry re-issued `respawn()` for everyone still dead, nesting into every other
  // plugin's `player_spawn` handlers again each time.
  //
  // Copied, not the live array: `activeSlots()` returns the registry's backing array and a nested
  // handler can splice it mid-loop.
  // Resync BEFORE the loop, not after: deciding from the registry and reconciling afterwards is
  // backwards, and it is how a stale "alive" survived long enough to skip someone's respawn. The
  // engine's health is the authority either way — see the same loop in `startGame`.
  reg.resyncAlive();
  const active = reg.activeSlots().slice();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isConnected(slot)) continue;   // a nested handler may have dropped them
    if (!isPlayingTeam(slot) || getHealth(slot) > 0) continue;
    respawn(slot);
  }
  reg.resyncAlive();

  // Anyone on a playing team still dead means the spawn has not LANDED yet. Wait a frame and try
  // again rather than dealing a role to a corpse.
  //
  // I removed this wait on the reasoning that a nested `respawn()` completes before it returns, so
  // liveness could be read immediately. The call does complete — but the engine does not place the
  // player in the world within it, so `resyncAlive()` on this same frame can still read them dead.
  // The round then went live with participants lying on the floor, including Traitors the win check
  // counts and nobody can kill. Counting REQUESTS was the old bug; not waiting at all was a worse
  // one. So: measure liveness, and still wait for it.
  let stillDead = 0;
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (reg.isConnected(slot) && !reg.isAlive(slot) && isPlayingTeam(slot)) stillDead++;
  }
  if (stillDead > 0 && attempt < SPAWN_SETTLE_FRAMES) {
    const mine = epoch;
    nextPreFrame(() => {
      if (mine !== epoch || game.state !== GameState.Countdown) return;
      beginRound(attempt + 1);
    });
    return;
  }
  if (stillDead > 0) {
    // Bounded, so one player the engine simply refuses to spawn cannot stall the round forever.
    console.log(`[ttt] WARN: starting with ${String(stillDead)} player(s) the engine would not spawn`);
  }

  // Spawns have landed (or the settle budget is spent), so close the window: from here on a death is
  // permanent. Done BEFORE roles are dealt so no participant can be respawned by the engine.
  setEngineRespawnAllowed(false);

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
  console.log(`[ttt/trace] beginRound: assigning roles, pool=${pool.length}`);
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
    nextPreFrame(() => {
      if (mine !== epoch || game.state !== GameState.InProgress) return;
      endGame(RoleId.Innocent, "Round ended due to timeout");
    });
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

/**
 * Slots seen as "registry says alive, engine says dead" on the LAST reconcile pass.
 *
 * A silent death is only acted on once it has been observed twice running, a second apart. The
 * transients this filters out are real: `deal` moves the Detective to CT and `switchTeam` may
 * respawn the pawn, so for a frame or two at the very top of a round that player legitimately has
 * no live pawn to read. Acting on a single observation would kill them off the moment they were
 * dealt the role.
 */

/**
 * Re-derive the roster and liveness from the ENGINE, and end the round if that changes the answer.
 *
 * `checkEndConditions` is O(1) because it reads counters the registry maintains incrementally, from
 * events. That is only sound while every departure and every death actually delivers an event, and
 * two common ones do not:
 *
 * - **A slay.** `pawn.slay()` (CommitSuicide) produces no `player_death` this plugin receives —
 *   verified on a live server, and the reason {@link killWithGadget} exists at all. An admin
 *   `sm_slay` therefore left the victim's alive flag set forever. Slay the last Traitor and the
 *   Innocents never won: the registry still counted a living Traitor, so the round ran until the
 *   round timer expired minutes later.
 * - **A kick, or any disconnect whose client event is missed.** `syncRoster` was called only from
 *   the WAITING and COUNTDOWN paths, never during a live round, so a roster that drifted mid-round
 *   stayed drifted for the rest of it — a kicked player kept his role, his alive flag and his vote
 *   in the win condition.
 *
 * The 1 Hz `checkEndConditions` poll was supposed to be the safety net for exactly this, but it
 * re-read the same stale counters every second and so could never converge on an answer they did
 * not already contain. This runs at the same 1 Hz and fixes the INPUT first, which is what makes
 * that poll a real guarantee rather than a repeated identical question.
 *
 * Cost is one `Player.allConnected()` and one pawn read per participant, once a second.
 */
export function reconcileRound(): void {
  if (game.state !== GameState.InProgress) return;

  // Roster first: a slot the engine no longer reports is dropped here, which clears its role and
  // decrements the alive counter it was still contributing to.
  syncRosterAndAnnounce();

  // Liveness is just re-read from the engine now.
  //
  // This used to be a two-strike walk that manufactured a synthetic `death` bus event for anyone
  // we believed alive but the engine said was dead. That machinery existed for one reason: a slay
  // produced no `player_death` we received, so a slain player stayed "alive" forever and the round
  // never resolved. Since core #108 a slay fires `player_death` onPre during the call, so there is
  // nothing left to reconstruct — and reconstructing it cost a full round-hanging poll of latency.
  reg.resyncAlive();

  checkEndConditions();
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
  // Take last round's arsenal back NOW, not when the next round's roles are dealt: the window
  // between the restart and role selection is when players arm themselves off the map, and stripping
  // at assignment confiscated exactly that. See `stripRoundWeapons`.
  stripRoundWeapons();
  printLogs();
  game.roundsThisMap++;

  const endReason =
    winner === RoleId.Traitor ? RoundEndReason.TerroristsWin : RoundEndReason.CTsWin;

  // The end-of-round win panel, fired the moment TTT decides the round — `RoundTimerListener`'s
  // `endRound` does exactly this with `EventCsWinPanelRound(true)` and `final_event` 2/3. It is
  // what tells a player the round is OVER rather than merely quiet: without it the free-roam
  // window below reads as the round still running, and the winner is only ever announced in chat.
  //
  // Broadcast, not server-only: the panel is a client-side thing and suppressing it would defeat
  // the point of firing it.
  Events.fire("cs_win_panel_round", {
    final_event:
      winner === RoleId.Traitor ? WinPanelFinalEvent.TerroristsWin : WinPanelFinalEvent.CTsWin,
  });

  if (winner !== RoleId.None) {
    Teams.addScore(winner === RoleId.Traitor ? Team.Terrorist : Team.CounterTerrorist, 1);
  }

  // Terminate NOW, and let the ENGINE own the post-round window.
  //
  // CS's own shape is: the round ends, everyone keeps running around for
  // `mp_round_restart_delay` seconds, then the map resets and everyone respawns at their spawn
  // point. That delay is an argument to `terminateRound`, so passing it here IS the free-roam
  // window — no second clock on our side.
  //
  // This used to wait `timeBetweenRounds` (1s) and THEN terminate with a hard-coded 3, which gave
  // a ~4s window split across two competing timers, neither matching `mp_round_restart_delay`.
  const postRound = Math.max(1, cfg.postRoundSeconds);
  Server.setCvar("mp_round_restart_delay", String(postRound));

  const mine = ++epoch;
  nextPreFrame(() => {
    if (mine !== epoch) return;
    // When the ENGINE ended this round its own restart is already pending, so terminating again
    // would cut the restarting round short a second or two in.
    if (engineDriven) return;
    // These bracket the terminate. They did not before: `terminateRound` is a synchronous engine
    // call while both `Server.command` writes sat in the console buffer, so the real order was
    // terminate-then-both-writes and the guard never covered the call it guards.
    Server.setCvar("mp_ignore_round_win_conditions", "1");
    GameRules.terminateRound(endReason, postRound);
    Server.setCvar("mp_ignore_round_win_conditions", "0");
  });

  // Watchdog on FINISHED. Nothing inside TTT drives the round forward from here: the next round is
  // started by the engine's `round_start` landing after the terminate above, and FINISHED is the
  // one state no ticker services (`tickWaiting` and `tickCountdown` both bail on it). If that
  // restart never arrives — a terminate the engine dropped, an admin freezing the round, a map
  // running its own round logic — the mode deadlocks with everyone stood in the end-of-round
  // reveal forever. Fall back to WAITING and let the idle poller take it from there.
  void delay((cfg.postRoundSeconds + FINISHED_TIMEOUT) * 1000).then(() => {
    nextPreFrame(() => {
      // Any legitimate restart moves the state on (and `startGame` bumps `epoch`), so a live token
      // AND a still-FINISHED state together mean the restart really is never coming.
      if (mine !== epoch || game.state !== GameState.Finished) return;
      returnToWaiting();
    });
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
  // Idle: nobody is playing a round, so spawning freely is correct and it means a player who joins an
  // empty server is put in the world instead of watching from the floor.
  setEngineRespawnAllowed(true);
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
 * `eligible()` only deals roles to the living. This sweep is NOT a retry — since core #108 a
 * respawn either takes on this call or is refused by game rules, and would be refused
 * identically a second later. It exists for players who join or change team DURING the
 * countdown (bots included, which never fire `ctx.clients.onActive`), and for last round's
 * revealed Innocents still sitting on CT.
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

  // Copied, and re-checked per iteration: `activeSlots()` hands back the registry's live
  // backing array, and since core #108 the outbound call in this loop runs other plugins'
  // handlers before it returns — one of which can disconnect a player and splice this array
  // mid-walk. That shifts every later element left, silently skipping someone.
  const active = reg.activeSlots().slice();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isConnected(slot)) continue;
    if (!isPlayingTeam(slot)) {
      continue;
    }
    if (!reg.isAlive(slot)) {
      respawn(slot);
      continue;
    }
    // Alive already — which means they carried last round's health, armor and inflated max health
    // in with them. A respawn would fix that but also teleport them back to spawn mid-countdown, so
    // reset the values directly instead. See `restoreFullHealth`.
    restoreFullHealth(slot);
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

/**
 * Abandon the live round without touching pawns, teams, or loadouts.
 *
 * Hot reload must not `switchTeam` / respawn / strip: that is extra index churn in the same window
 * as icon/DNA teardown. The replacement instance starts `Waiting` and does not spawn role entities
 * until the next deal, after at least one simulation has processed the queued `Kill`s.
 */
export function abandonRound(): void {
  epoch++;
  engineEndedRound = false;
  game.state = GameState.Waiting;
  game.winner = RoleId.None;
  waitingAccum = 0;
  countdownAccum = 0;
  setSpoofingEnabled(false);
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
  // abandoned round, so `sm_ttt_special_min_rounds_after_map` (read as `roundsThisMap < n`) came
  // due one full round early after every map change.
  game.roundsThisMap = 0;
  // Bump LAST, not first. `endGame` arms its own timers (the round-end terminate and the FINISHED
  // watchdog) against a fresh token, so a bump taken before it invalidates only the timers of the
  // round that is already over and leaves those two live — they would then fire into the new map,
  // terminating its opening round a second after it loads and forcing a round start on top.
  epoch++;
}
