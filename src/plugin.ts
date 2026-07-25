/**
 * TTT (Trouble in Terrorist Town) — an s2script port of https://github.com/edgegamers/TTT.
 *
 * ## Layout
 *
 * | module     | ports                                                     |
 * |------------|-----------------------------------------------------------|
 * | `core/`    | `TTT.API`, `TTT.Game.EventBus`, `TTT.Locale`, the configs  |
 * | `game/`    | `RoundBasedGame`, `RoleAssigner`, `SimpleLogger`           |
 * | `cs2/`     | `TTT.CS2` — pawns, bodies, combat, USE interactions        |
 * | `karma/`   | `TTT.Karma`                                                |
 * | `shop/`    | `ShopAPI` + `TTT.Shop` + every item under `CS2/Items`      |
 * | `special/` | `SpecialRoundAPI` + `TTT.SpecialRound`                     |
 *
 * ## Why it is shaped this way
 *
 * The C# build leans on DI, reflection and `Task` for control flow that is here neither async nor
 * dynamic. The three changes that matter most for server frame time:
 *
 * 1. **One frame handler.** The original registered a `RegisterListener<OnTick>` plus several
 *    `AddTimer(...)` and `SchedulePeriodic(...)` subscriptions across `PropMover`, `NameDisplayer`,
 *    `CS2AliveSpoofer`, `PeriodicRewarder`, `RoundTimerListener` and each station/tripwire item.
 *    Everything periodic here runs from the single `ctx.server.onGameFrame` below, each subsystem
 *    keeping its own accumulator.
 *
 * 2. **Slot-indexed state.** Roles, karma, balances, alive flags and item charges are entries in
 *    fixed 64-wide typed arrays rather than `Dictionary<string, T>` keyed by a SteamID *string*.
 *    A role check went from "hash a string, probe a dictionary, allocate a collection, run N runtime
 *    type tests" to one array load and an integer compare.
 *
 * 3. **Config is a snapshot.** Every C# config property getter re-resolved an `IStorage<T>` from the
 *    container, allocated a fresh record and blocked on a `Task`. Here the ConVars are parsed once
 *    into a plain object and refreshed at round boundaries.
 *
 * Incremental alive-counters (so the win check is O(1)), a compiled phrase table, and coalesced
 * damage logging are the other notable departures; each is documented at its own module.
 */

import { plugin } from "@s2script/sdk/plugin";
import { Server } from "@s2script/sdk/server";
import { HookResult, type HookResultValue } from "@s2script/sdk/events";
import { GameState, Team } from "./core/enums";
import { EventBus, Priority } from "./core/bus";
import type { TttEvents } from "./core/events";
import { registerCvars, refresh, cfg } from "./core/cvars";
import { config } from "@s2script/sdk/config";
import { msg, precompileAll, setPhrases } from "./core/msgs";
import * as reg from "./core/registry";

import {
  checkEndConditions, game, initGame, inWarmup, onEngineRoundStart, onMapChange, startGame,
  syncRosterAndAnnounce, tickCountdown, tickWaiting,
} from "./game/game";
import { logPurchase, logRoleAssigned } from "./game/logger";
import { roleName } from "./game/roles";

import { invalidatePawnCache, onDamage, onDeathPre, onPlayerHurt, onSpawn } from "./cs2/combat";
import { clearBodies, precacheBodyModels } from "./cs2/bodies";
import { initInteract, resetInteract, tickInteract } from "./cs2/interact";
import { resetSpoof, tickSpoof } from "./cs2/spoof";
import { installFeedback } from "./cs2/feedback";
import {
  handleChat, installBombSuppressor, installHandlers, onItemPurchase, onTeamChange,
  removeBuyZones, setSelfSpectateHandler, tickHandlers, unmuteAll,
} from "./cs2/handlers";

import { installKarma } from "./karma/karma";
import { initShop, itemById, refreshItems } from "./shop/shop";
import { registerItems } from "./shop/items";
import { installEffects, releaseC4, resetEffects, tickEffects } from "./shop/effects";
import { installEconomy, tickEconomy } from "./shop/economy";
import { installSpecialRounds, tickSpecialRounds } from "./special/rounds";
import { installWeaponFx, onHeDetonate, onSmokeDetonate, resetWeaponFx } from "./shop/weaponfx";

import { registerCommands } from "./commands";

/**
 * Load an operator-supplied phrase file, if `phrases_file` names one. It is a flat
 * `{ "KEY": "text" }` JSON object using the same `%KEY%` / `{color}` / `{0}` / `%s%` / `%an%` syntax
 * as the built-in table; unknown keys fall back to English.
 */
function loadPhraseOverrides(): void {
  const name = config.getString("phrases_file");
  if (name === "") return;
  const raw = config.readFile(name);
  if (raw === null) {
    console.warn(`[ttt] phrases_file "${name}" not found in the configs directory`);
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    setPhrases(parsed as Record<string, string>);
  } catch (err) {
    console.error(`[ttt] phrases_file "${name}" is not valid JSON: ${String(err)}`);
  }
}

/**
 * The server settings TTT cannot function without.
 *
 * Applied at load, on map start AND on round start. A hot reload re-runs the factory but never
 * re-fires `onMapStart`; and the map's own `gamemode_*.cfg` execs after `onMapStart`, overwriting
 * anything set there. Round start is the one point guaranteed to be after both.
 *
 * Deliberately NOT set here: warmup length, round time, buy time and money. Those are operator
 * preference — a `gamemode_custom.cfg` owns them, and TTT works with whatever it finds. TTT waits
 * out warmup rather than cancelling it (`warmup_end` and the idle poller both retry), and drives
 * the round clock through `GameRules.setTimeRemaining` rather than `mp_roundtime`.
 */
function applyServerSettings(): void {
  // TTT decides its own round outcomes — without this the engine ends rounds out from under it.
  Server.command("mp_ignore_round_win_conditions 1");
  // The engine's idle-kick fights the mode: TTT players legitimately stand still (working out who
  // to trust, watching a body, waiting out a countdown) and get kicked for it. TTT does its own,
  // gentler AFK handling — a warning, then a move to spectator, never a kick.
  Server.command("mp_autokick 0");
  Server.command("mp_disable_autokick 1");

  // Defensive defaults for a server with no TTT-aware gamemode cfg. A proper `gamemode_custom.cfg`
  // will already set these; re-issuing them is harmless and keeps TTT playable without one.
  Server.command("mp_teammates_are_enemies 1"); // everyone can hurt everyone
  Server.command("mp_friendlyfire 1");
  Server.command("mp_halftime 0"); // a team swap mid-match would scramble roles
  Server.command("mp_maxrounds 0"); // TTT rounds are not a match
  Server.command("mp_match_can_clinch 0");
  Server.command("mp_autoteambalance 0"); // teams are a TTT implementation detail
  Server.command("mp_limitteams 0");
}

export default plugin((ctx) => {
  const bus = new EventBus<TttEvents>();

  // ── configuration ─────────────────────────────────────────────────────────
  registerCvars();
  refresh();
  loadPhraseOverrides();
  precompileAll();

  // ── subsystem wiring ──────────────────────────────────────────────────────
  initGame(bus);
  initShop(bus);
  initInteract(bus);

  registerItems();
  refreshItems();

  installKarma(bus);
  installEconomy(bus);
  installEffects(bus);
  installSpecialRounds(bus);
  installWeaponFx(bus);
  installHandlers(bus);
  installFeedback(bus);
  // Ducking out to spectator mid-round counts as dying — it must not be a way to dodge a Traitor.
  setSelfSpectateHandler((slot) => {
    reg.setAlive(slot, false);
    bus.emit("death", { slot, killer: -1, assister: -1, weapon: "", headshot: false });
    checkEndConditions();
  });

  // Log lines the round logger owns but that other subsystems' events produce. MONITOR priority so
  // the entry records the role karma may have rewritten, not the one originally dealt.
  bus.on(
    "roleAssign",
    (ev) => {
      if (!ev.canceled) logRoleAssigned(ev.slot, ev.role, roleName(ev.role));
    },
    { priority: Priority.MONITOR },
  );
  bus.on(
    "purchase",
    (ev) => {
      const item = itemById(ev.itemId);
      if (item !== undefined) logPurchase(ev.slot, msg(item.nameKey));
    },
    { priority: Priority.MONITOR, ignoreCanceled: true },
  );

  // Refresh the config snapshot once per round rather than per config read.
  bus.on(
    "gameState",
    (ev) => {
      if (ev.state !== GameState.InProgress) return;
      refresh();
      refreshItems();
    },
    { priority: Priority.HIGHEST },
  );

  // ── client lifecycle ──────────────────────────────────────────────────────
  // Handlers only fire for clients connecting AFTER the plugin goes active, so seed the registry
  // from the engine first — a hot reload mid-map would otherwise start with an empty roster. This
  // goes through the announcing path so `join` fires for everyone seeded, which is what
  // initialises their karma.
  syncRosterAndAnnounce();

  ctx.clients.onActive((client) => {
    reg.addPlayer(client.slot, client.steamId, client.name);
    reg.setAlive(client.slot, reg.computeAlive(client.slot));
    bus.emit("join", { slot: client.slot });

    // A player joining an idle server is what starts the first round.
    if (game.state === GameState.Waiting && reg.playerCount() >= cfg.minPlayers) startGame();
  });

  ctx.clients.onDisconnect((client) => {
    bus.emit("leave", { slot: client.slot });
    reg.removePlayer(client.slot);
    invalidatePawnCache();
    checkEndConditions();
  });

  ctx.clients.onSay((slot, text): HookResultValue | void => handleChat(slot, text));

  // ── game events ───────────────────────────────────────────────────────────
  ctx.events.onPre("player_death", (ev) => onDeathPre(bus, ev));

  ctx.events.on("player_spawn", (ev) => {
    const slot = ev.getPlayerSlot("userid");
    if (slot >= 0) onSpawn(slot);
  });

  ctx.events.on("player_team", (ev) => {
    const slot = ev.getPlayerSlot("userid");
    onTeamChange(slot, ev.getInt("team") as Team);
    // A team change alters who is eligible; re-derive liveness and re-check the round.
    reg.resyncAlive();
    checkEndConditions();
  });

  ctx.events.on("round_start", () => {
    // Re-assert the required settings here as well as on map start: the map's own `gamemode_*.cfg`
    // execs AFTER `onMapStart`, so anything set there is overwritten (`mp_warmuptime` in
    // particular, which would otherwise keep the server in a warmup TTT never starts a round from).
    applyServerSettings();
    invalidatePawnCache();
    onEngineRoundStart();
  });

  // Warmup blocks the round start; pick it back up the moment warmup finishes.
  ctx.events.on("warmup_end", () => {
    syncRosterAndAnnounce();
    if (game.state === GameState.Waiting) startGame();
  });

  // The engine's own round end must not decide a TTT round; TTT ends its rounds itself.
  ctx.events.onPre("round_end", (): HookResultValue | void => {
    if (game.state === GameState.InProgress) return HookResult.Handled;
  });

  // A resolved bomb frees up a C4 slot for the "max at once" purchase gate.
  ctx.events.on("bomb_exploded", () => releaseC4());
  ctx.events.on("bomb_defused", () => releaseC4());

  // Grenade detonations drive the Poison Smoke and Cluster Grenade items.
  ctx.events.on("smokegrenade_detonate", (ev) => {
    onSmokeDetonate(ev.getPlayerSlot("userid"), ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"));
  });

  ctx.events.on("hegrenade_detonate", (ev) => {
    onHeDetonate(ev.getPlayerSlot("userid"), ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"));
  });

  ctx.events.onPre("item_purchase", (ev): HookResultValue | void => {
    const slot = ev.getPlayerSlot("userid");
    if (slot < 0) return;
    return onItemPurchase(slot, ev.getString("weapon")) ? HookResult.Handled : undefined;
  });

  // ── entity + damage ───────────────────────────────────────────────────────
  ctx.entities.onDamage((info) => onDamage(bus, info));
  // Fallback while the pre-hook does not receive real combat damage — see `onPlayerHurt`.
  ctx.events.on("player_hurt", (ev) => onPlayerHurt(bus, ev));

  // ── map lifecycle ─────────────────────────────────────────────────────────
  ctx.server.onPrecache((pc) => {
    precacheBodyModels(pc);
  });

  ctx.server.onMapStart(() => {
    onMapChange();
    reg.seedFromEngine();
    removeBuyZones();
    resetInteract();
    resetEffects();
    resetSpoof();
    resetWeaponFx();
    refresh();
    refreshItems();
    applyServerSettings();
  });

  installBombSuppressor();


  applyServerSettings();

  // ── the one frame handler ─────────────────────────────────────────────────
  // Everything periodic in this plugin is driven from here. `Server.gameTime` is the map clock, so
  // `dt` is real elapsed seconds and each subsystem gates itself on its own accumulator.
  let lastTime = Server.gameTime;
  let endCheckAccum = 0;

  ctx.server.onGameFrame(() => {
    const now = Server.gameTime;
    const dt = now - lastTime;
    lastTime = now;
    // A map change rewinds the clock; skip the frame rather than feeding a bad dt onwards.
    if (dt <= 0 || dt > 1) return;

    tickHandlers(dt);
    tickSpoof();
    tickWaiting(dt);
    tickCountdown(dt);
    if (game.state !== GameState.InProgress) return;

    tickInteract(dt);
    tickEffects(dt);
    tickEconomy(dt);
    tickSpecialRounds();

    // Convergence guarantee: the win condition is also checked on death and disconnect, but a
    // missed trigger would otherwise hang the round forever. The check is three integer reads.
    endCheckAccum += dt;
    if (endCheckAccum >= 1) {
      endCheckAccum = 0;
      checkEndConditions();
    }
  });

  // ── commands ──────────────────────────────────────────────────────────────
  registerCommands(ctx.commands);

  console.log("[ttt] loaded — Trouble in Terrorist Town");

  return {
    onUnload() {
      clearBodies(true);
      resetEffects();
      resetWeaponFx();
      resetInteract();
      resetSpoof();
      unmuteAll();
      reg.resetRegistry();
      bus.clear();
      Server.command("mp_ignore_round_win_conditions 0");
    },
  };
});
