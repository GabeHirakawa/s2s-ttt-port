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
import { GameState, RoleId, Team } from "./core/enums";
import { EventBus, Priority } from "./core/bus";
import type { TttEvents } from "./core/events";
import { registerCvars, refresh, cfg } from "./core/cvars";
import { config } from "@s2script/sdk/config";
import { installPhrases, msg, precompileAll } from "./core/msgs";
import * as reg from "./core/registry";

import {
  checkEndConditions, game, initGame, inWarmup, onEngineRoundEnd, onEngineRoundStart, onMapChange,
  reconcileRound, startGame, syncRosterAndAnnounce, tickCountdown, tickWaiting,
} from "./game/game";
import { logPurchase, logRoleAssigned } from "./game/logger";
import { clearReservedRoles, roleName } from "./game/roles";

import {
  installDeathFeedSuppressor, installMatchStats, invalidatePawnCache, onDamage, onDeathPre,
  onPlayerHurt, onSpawn, setDeathBus,
} from "./cs2/combat";
import { clearBodies, precacheBodyModels } from "./cs2/bodies";
import { initInteract, resetInteract, tickInteract } from "./cs2/interact";
import { reassertSpoof, resetSpoof, tickSpoof } from "./cs2/spoof";
import { installFeedback } from "./cs2/feedback";
import { clearBenched, wouldRefuseTeam } from "./game/teams";
import { installIcons, precacheRoleModels, resetIcons } from "./cs2/icons";
import {
  benchLateJoiner, handleChat, installBombSuppressor, installHandlers, onItemPurchase, onTeamChange,
  removeBuyZones, resetBuyZones, setSelfSpectateHandler, tickHandlers, unmuteAll,
} from "./cs2/handlers";

import { installKarma } from "./karma/karma";
import { initShop, itemById, refreshItems } from "./shop/shop";
import { registerItems } from "./shop/items";
import {
  installEffects,
  onBulletImpact,
  precacheEffectModels,
  releaseC4,
  resetEffects,
  tickEffects,
} from "./shop/effects";
import { installEconomy, tickEconomy } from "./shop/economy";
import { installSpecialRounds, tickSpecialRounds } from "./special/rounds";
import {
  installWeaponFx, onHeDetonate, onSmokeDetonate, onSmokeExpired, onWeaponFire, resetWeaponFx,
  tickWeaponFx, tickDnaTracker,
} from "./shop/weaponfx";

import { resetHud, tickHud } from "./cs2/hud";
import { onPlayerPing, registerCommands, resetShopMenus } from "./commands";

/**
 * Load an operator-supplied phrase file, if `phrases_file` names one. It is a flat
 * `{ "KEY": "text" }` JSON object using the same `%KEY%` / `{color}` / `{0}` / `%s%` / `%an%` syntax
 * as the built-in table; unknown keys fall back to English.
 *
 * This is folded into the SEED handed to `Translations.load`, so it still works exactly as before —
 * and the SDK's own `translations/<code>/ttt.phrases.json` files then layer per-language text on top
 * of it, which is the part TTT no longer implements itself.
 */
function installTranslations(): void {
  const name = config.getString("phrases_file");
  if (name === "") {
    installPhrases();
    return;
  }
  const raw = config.readFile(name);
  if (raw === null) {
    console.log(`[ttt] WARN: phrases_file "${name}" not found in the configs directory`);
    installPhrases();
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    installPhrases(parsed as Record<string, string>);
  } catch (err) {
    console.log(`[ttt] ERROR: phrases_file "${name}" is not valid JSON: ${String(err)}`);
    // Register the built-ins anyway: without a load() every message would render as its raw key.
    installPhrases();
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
  // VOICE. TTT arbitrates who can hear whom itself (`Voice.setAudibleTo` — dead players talk to the
  // dead, the living cannot listen in), which requires the ENGINE to be permissive between LIVING
  // players so the plugin can do the restricting. With alltalk off entirely, the engine also blocks
  // living voices across the team line and the result on a live server was that nobody could hear
  // anybody. Same category as `mp_teammates_are_enemies`: the engine is opened up so TTT arbitrates.
  Server.command("sv_alltalk 1");
  // `sv_full_alltalk` is deliberately NOT set. It governs the ALIVE/DEAD line, which is the one
  // boundary TTT most needs held: a dead player naming their killer to the living ends the round's
  // central secret. Turning it on would make the plugin's voice masks the ONLY thing preventing that
  // leak; leaving it off keeps the engine as a second barrier underneath them. Dead-to-dead voice
  // does not need it — that is the engine's default behaviour for dead players.

  // CLIENT-CRASH MITIGATION, asserted here rather than left to operator config.
  //
  // TTT filters entity visibility per viewer (role icons, the traitor glow) through a CheckTransmit
  // hook. With parallel entity packing on, worker threads pack per-client deltas while those bitvecs
  // are being edited, and a client receives an update for an entity whose create it never got —
  // `CopyExistingEntity: missing client entity N`, which drops the player out of the game. Alternate
  // baselines compound it: that table is index-keyed with NO serial check, and entity indices are
  // recycled constantly here (corpses, icons and glow props share them freely).
  //
  // These live with the plugin because the plugin is what creates the hazard. A server cfg is not
  // enough on its own: loading a WORKSHOP map refuses these three by name at cfg-exec time
  // ("DISALLOWED WORKSHOP CONVAR"), so a server that boots straight onto a workshop map never
  // applies them. They ARE settable at runtime, which is what makes asserting them here work.
  Server.command("sv_parallel_packentities 0");
  Server.command("sv_parallel_sendsnapshot 0");
  Server.command("sv_enable_alternate_baselines 0");

  // NOT set here: `mp_respawn_on_death_t/ct`. Those are a TTT-owned TOGGLE, flipped per round state by
  // `setEngineRespawnAllowed` in game.ts — the engine refuses `Respawn` while they are off, and leaving
  // them on would respawn players the instant they die mid-round. Re-asserting either value from here
  // would fight that.
}

export default plugin((ctx) => {
  const bus = new EventBus<TttEvents>();

  // ── configuration ─────────────────────────────────────────────────────────
  registerCvars();
  refresh();
  installTranslations();
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
  // combat.ts self-installs on the first death, but wiring it here also catches the round-start
  // scoreboard clear that happens before anyone has died.
  installMatchStats(bus);
  // Installed HERE, in the load window — not lazily from the death hook. A `UserMessages.onPre`
  // subscribe made from inside a game-event dispatch never took effect (measured: 40 death windows,
  // zero invocations), and this is what hides the kill feed.
  installDeathFeedSuppressor();
  installFeedback(bus);
  installIcons(bus);
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
      if (ev.state !== GameState.InProgress) {
        // A menu printed last round must not still be answerable this one: its numbering came from
        // the old role and balance, so a stale digit would buy something the player never saw.
        if (ev.state === GameState.Finished) resetShopMenus();
        return;
      }
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

    // Bench a live-round arrival HERE, not only when they pick a team. A freshly connected
    // controller sits on `Team.None` with no pawn, and the engine leaves its alive mirror set — so
    // until they touched the team menu they read as ALIVE on every scoreboard while being unable to
    // play. Waiting for `player_team` also never fires for a player who simply never chooses.
    if (game.state === GameState.InProgress && reg.roleOf(client.slot) === RoleId.None) {
      benchLateJoiner(client.slot);
      return;
    }

    // A player joining an idle server is what starts the first round.
    if (game.state === GameState.Waiting && reg.playerCount() >= cfg.minPlayers) startGame();
  });

  // POST player_death: put the alive flag back after the engine has written its own, in the same
  // frame. The pre-hook cannot do this — the engine's write happens after it. See `reassertSpoof`.
  ctx.events.on("player_death", (ev) => {
    const victim = ev.getPlayerSlot("userid");
    if (victim >= 0) reassertSpoof(victim);
  });

  ctx.clients.onDisconnect((client) => {
    bus.emit("leave", { slot: client.slot });
    reg.removePlayer(client.slot);
    invalidatePawnCache();
    checkEndConditions();
  });

  ctx.clients.onSay((slot, text): HookResultValue | void => handleChat(slot, text));

  // ── game events ───────────────────────────────────────────────────────────
  // Seed the gadget-kill path with the bus up front: it drives deaths that no engine event announces
  // (see `killWithGadget`), so it cannot wait for the first `player_death` to supply one.
  setDeathBus(bus);
  ctx.events.onPre("player_death", (ev) => onDeathPre(bus, ev));

  ctx.events.on("player_spawn", (ev) => {
    const slot = ev.getPlayerSlot("userid");
    if (slot >= 0) onSpawn(slot);
  });

  // Suppress the client broadcast for a team change TTT is about to undo. `Handled` stops the
  // "X has joined the Spectators" notification reaching clients; the server still applies the
  // change, which the post-event handler below reverses. Splitting it this way means the switch is
  // issued exactly once, while the leak — a dead player's team move announcing their death — never
  // reaches anybody.
  ctx.events.onPre("player_team", (ev): HookResultValue | void => {
    const slot = ev.getPlayerSlot("userid");
    if (wouldRefuseTeam(slot, ev.getInt("team") as Team, ev.getBool("disconnect"))) {
      return HookResult.Handled;
    }
  });

  ctx.events.on("player_team", (ev) => {
    const slot = ev.getPlayerSlot("userid");
    // A leaving player fires `player_team` for team None on the way out; the flag lets the team
    // guard tell that apart from a live player ducking to spectator, which it must undo.
    onTeamChange(slot, ev.getInt("team") as Team, ev.getBool("disconnect"));
    // A team change alters who is eligible; re-derive liveness and re-check the round.
    reg.resyncAlive();
    checkEndConditions();
  });

  ctx.events.on("round_start", () => {
    // Re-assert the required settings here as well as on map start: the map's own `gamemode_*.cfg`
    // execs AFTER `onMapStart`, so anything set there is overwritten (`mp_warmuptime` in
    // particular, which would otherwise keep the server in a warmup TTT never starts a round from).
    applyServerSettings();
    // Same reason the settings are re-applied here: the map's buy zones are not spawned yet at
    // `onMapStart`, so this is the first point at which they can actually be found and removed.
    removeBuyZones();
    invalidatePawnCache();
    onEngineRoundStart();
  });

  // Warmup blocks the round start; pick it back up the moment warmup finishes.
  ctx.events.on("warmup_end", () => {
    syncRosterAndAnnounce();
    if (game.state === GameState.Waiting) startGame();
  });

  // The engine's own round end must not decide a TTT round, but it does restart the round out from
  // under us — so suppress the broadcast AND fold the TTT round up behind it.
  ctx.events.onPre("round_end", (): HookResultValue | void => {
    if (game.state !== GameState.InProgress) return;
    onEngineRoundEnd();
    return HookResult.Handled;
  });

  // A resolved bomb frees up a C4 slot for the "max at once" purchase gate.
  ctx.events.on("bomb_exploded", () => releaseC4());
  ctx.events.on("bomb_defused", () => releaseC4());

  // Grenade detonations drive the Poison Smoke and Cluster Grenade items.
  ctx.events.on("smokegrenade_detonate", (ev) => {
    // The projectile index is what lets the poison cloud die with the smoke that carries it,
    // rather than running out a fixed lifetime the map's own smoke never agreed to.
    onSmokeDetonate(
      ev.getPlayerSlot("userid"),
      ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"),
      ev.getInt("entityid"),
    );
  });

  // The poison goes when the cloud does.
  ctx.events.on("smokegrenade_expired", (ev) => {
    onSmokeExpired(ev.getInt("entityid"));
  });

  ctx.events.on("hegrenade_detonate", (ev) => {
    onHeDetonate(ev.getPlayerSlot("userid"), ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"));
  });

  // Poison Shots burns a charge on every pistol trigger pull, hit or miss — the C# spent the charge
  // on FIRE and only READ the counter on damage, so the shot that spends the last one lands clean.
  ctx.events.on("weapon_fire", (ev) => {
    onWeaponFire(ev.getPlayerSlot("userid"), ev.getString("weapon"));
  });

  // Placed gadgets are shootable: a bullet pops a tripwire or takes a station's health down.
  ctx.events.on("bullet_impact", (ev) => {
    onBulletImpact(ev.getPlayerSlot("userid"), ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"));
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
    precacheRoleModels(pc);
    precacheEffectModels(pc);
  });

  ctx.server.onMapStart(() => {
    onMapChange();
    // BEFORE `seedFromEngine`: role name tags are written at the Finished transition and are still
    // on the engine names here, and `resetIcons` is what puts the originals back. Seeding first
    // would cache "[T] Bob" as Bob's real name and add a bracket on every map change.
    resetIcons();
    clearReservedRoles();
    reg.seedFromEngine();
    // Only clears the one-shot latch — the zones themselves are not spawned yet, so the removal
    // proper waits for `round_start`.
    resetBuyZones();
    resetInteract();
    resetEffects();
    resetSpoof();
    resetWeaponFx();
    // A compass strip or a look-at name from last round must not stay pinned to anyone's screen.
    resetHud();
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

  // The alive-spoof re-assert runs in the POST phase, on its own subscription — everything else
  // below is Pre.
  //
  // The controller's `m_bPawnIsAlive` is re-derived FROM the pawn by the controller's think, which
  // runs during simulation. A write from the Pre phase therefore lands BEFORE that derivation and is
  // overwritten by it, and the snapshot that goes out carries the real value — which is the
  // scoreboard flicker. Writing in Post lands after the derivation and before the snapshot, so there
  // is nothing left to overwrite it.
  //
  // This is what lets the spoof leave the pawn's own `lifeState` alone (see `tickSpoof`): the pawn
  // write was only ever there to win this ordering fight, and it cost dead players their freecam.
  ctx.server.onGameFrame(() => { tickSpoof(); }, { phase: "post" });

  ctx.server.onGameFrame(() => {
    const now = Server.gameTime;
    const dt = now - lastTime;
    lastTime = now;
    // A map change rewinds the clock; skip the frame rather than feeding a bad dt onwards.
    if (dt <= 0 || dt > 1) return;

    tickHandlers(dt);
    tickWaiting(dt);
    tickCountdown(dt);
    if (game.state !== GameState.InProgress) return;

    tickInteract(dt);
    tickEffects(dt);
    // AFTER the compass (both write the one centre-screen slot) and BEFORE the drain: a live DNA
    // lead is the more urgent of the two, so it wins the screen while it lasts.
    tickDnaTracker(dt);
    // The centre-screen HUD event paints for ONE frame, so every live line is re-fired here. What
    // each player should be seeing is set on slower cadences (the compass strip, the look-at name).
    tickHud();
    tickWeaponFx(dt);
    tickEconomy(dt);
    tickSpecialRounds();

    // Convergence guarantee: the win condition is also checked on death and disconnect, but a
    // missed trigger would otherwise hang the round forever.
    //
    // This reconciles the roster and liveness against the ENGINE before checking, rather than
    // re-reading the counters the missed trigger is exactly what left wrong. A bare
    // `checkEndConditions()` here asked the same question of the same stale numbers every second
    // and could never answer it differently — which is how a slay or a kick hung a round.
    endCheckAccum += dt;
    if (endCheckAccum >= 1) {
      endCheckAccum = 0;
      reconcileRound();
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
      resetHud();
      resetShopMenus();
      clearBenched();
      // Drops the role icons and puts every tagged name back: an unload must not leave "[T] Bob".
      resetIcons();
    clearReservedRoles();
      unmuteAll();
      reg.resetRegistry();
      bus.clear();
      Server.command("mp_ignore_round_win_conditions 0");
    },
  };
});
