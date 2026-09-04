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
 *    Everything periodic here runs from the single `scope.server.onGameFrame` below, each subsystem
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

import { createScope } from "@s2script/sdk/plugin";
import { command } from "@s2script/sdk/commands";
import { SDKHook, SDKHookType } from "@s2script/sdk/sdkhooks";
import { Entity, type EntityRef } from "@s2script/sdk/entity";
import { items } from "@s2script/cs2";
import { tell, tellAll, pawnOf } from "./cs2/pawn";
import { resetBuyMenu, tickBuyMenu } from "./cs2/buymenu";
import { queueSlays, serveRoundStart, resetSanctions, recordGuilty, pardon } from "./rdm/sanctions";
import { captureSay, installRdmFlow, resetRdmFlow, tickRdmFlow } from "./rdm/flow";
import { Bans } from "@s2script/sdk/bans";
import { Clients } from "@s2script/sdk/clients";
import { Admin, ADMFLAG } from "@s2script/sdk/admin";
import { TttHud, setTttHud, getTttHud } from "./cs2/ttthud";
import { Server } from "@s2script/sdk/server";
import { bindPreFrameIdentity, drainPreFrame } from "./core/preframe";
import { teardownWorld } from "./core/teardown";
import { HookResult, type HookResultValue } from "@s2script/sdk/events";
import { GameState, RoleId, Team } from "./core/enums";
import { EventBus, Priority } from "./core/bus";
import type { TttEvents } from "./core/events";
import { registerCvars, refresh, cfg } from "./core/cvars";
import { config } from "@s2script/sdk/config";
import { installPhrases, msg, precompileAll } from "./core/msgs";
import * as reg from "./core/registry";

import {
  checkEndConditions, game, initGame, inWarmup, onEngineRoundEnd, onEngineRoundStart,
  reconcileRound, startGame, syncRosterAndAnnounce, tickCountdown, tickWaiting,
} from "./game/game";
import { logPurchase, logRoleAssigned } from "./game/logger";
import { roleName } from "./game/roles";

import {
  installDeathFeedSuppressor, installMatchStats, invalidatePawnCache, onDamage, onDeathPre,
  onPlayerHurt, onSpawn, setDeathBus,
} from "./cs2/combat";
import { precacheBodyModels } from "./cs2/bodies";
import { initInteract, inspectIdentify, tickInteract } from "./cs2/interact";
import { reassertSpoof, tickSpoof } from "./cs2/spoof";
import { installFeedback } from "./cs2/feedback";
import { wouldRefuseTeam } from "./game/teams";
import { installIcons, precacheRoleModels } from "./cs2/icons";
import {
  benchLateJoiner, handleChat, installBombSuppressor, installHandlers, onCanAcquire, onItemPurchase,
  onJoinTeamCommand, onTeamChange, removeBuyZones, resetBuyZones, setSelfSpectateHandler,
  tickHandlers,
} from "./cs2/handlers";

import { installKarma } from "./karma/karma";
import { initShop, itemById, refreshItems } from "./shop/shop";
import { registerItems } from "./shop/items";
import {
  installEffects,
  onBulletImpact,
  precacheEffectModels,
  releaseC4,
  tickEffects,
} from "./shop/effects";
import { installEconomy, tickEconomy } from "./shop/economy";
import { installSpecialRounds, tickSpecialRounds } from "./special/rounds";
import {
  installWeaponFx, onHeDetonate, onSmokeDetonate, onSmokeExpired, onWeaponFire,
  tickWeaponFx, tickDnaTracker,
} from "./shop/weaponfx";

import { tickHud } from "./cs2/hud";
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
  Server.setCvar("mp_ignore_round_win_conditions", "1");
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
  // vaudio_speex produced severe, painful distortion for some speakers on a live server; the steam
  // codec is the one that works. Asserted here for the same reason as the cvars below: a workshop
  // map load refuses `sv_voicecodec` by name, so a server cfg alone loses it on every TTT map.
  Server.command("sv_voicecodec vaudio_steam");
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
  // The CS2 buy menu is client-side Panorama and cannot be replaced from here, so make it INERT
  // instead: 3 = "nobody can buy". The panel still opens on B — and `cs2/buymenu.ts` turns that
  // keypress into the TTT shop — but the engine's own list is empty and buys nothing behind ours.
  // TTT already refuses the grant at `onCanAcquire`; this is what stops the panel looking live.
  Server.command("sv_buy_status_override 3");

  Server.command("sv_parallel_packentities 0");
  Server.command("sv_parallel_sendsnapshot 0");
  Server.command("sv_enable_alternate_baselines 0");

  // NOT set here: `mp_respawn_on_death_t/ct`. Those are a TTT-owned TOGGLE, flipped per round state by
  // `setEngineRespawnAllowed` in game.ts — the engine refuses `Respawn` while they are off, and leaving
  // them on would respawn players the instant they die mid-round. Re-asserting either value from here
  // would fight that.
}

/**
 * Module-scoped so `OnPluginEnd` can tear the same bus down. Everything else this plugin owns
 * hangs off `OnPluginStart`'s scope, which the ledger clears on unload.
 */
const bus = new EventBus<TttEvents>();

export function OnPluginStart(): void {
  // One scope for every subscription. `Scope` is the only surface that carries the frame PHASE
  // and the client-lifecycle callbacks together; the SourceMod-shaped publics (`OnGameFrame`,
  // `OnClientActive`, ...) are one-per-module and cannot express the post-phase paint below.
  const scope = createScope();

  // ── configuration ─────────────────────────────────────────────────────────
  registerCvars();
  refresh();
  installTranslations();
  precompileAll();

  // ── subsystem wiring ──────────────────────────────────────────────────────
  initGame(bus);
  bindPreFrameIdentity((slot) => ({ steamId: reg.steamIdOf(slot), gen: reg.generationOf(slot) }));
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
    "roleAssigned",
    (ev) => {
      logRoleAssigned(ev.slot, ev.role, roleName(ev.role));
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
        if (ev.state === GameState.Finished) {
          resetShopMenus();
          // Drop the traitor badge and any open shop at round end. Leaving the badge up would keep
          // showing a dead round's roster into the next one.
          getTttHud()?.resetAll();
        }
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

  scope.clients.onActive((client) => {
    // Panels default VISIBLE in the markup, so collapse them until asked for.
    getTttHud()?.hideAll(client.slot);
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
  scope.events.on("player_death", (ev) => {
    const victim = ev.getPlayerSlot("userid");
    if (victim >= 0) reassertSpoof(victim);
  });

  scope.clients.onDisconnect((client) => {
    getTttHud()?.forget(client.slot);
    bus.emit("leave", { slot: client.slot });
    reg.removePlayer(client.slot);
    invalidatePawnCache();
    checkEndConditions();
  });

  scope.clients.onSay((slot, text): HookResultValue | void => handleChat(slot, text));

  // ── game events ───────────────────────────────────────────────────────────
  // Seed the gadget-kill path with the bus up front: it drives deaths that no engine event announces
  // (see `killWithGadget`), so it cannot wait for the first `player_death` to supply one.
  setDeathBus(bus);
  scope.events.onPre("player_death", (ev) => onDeathPre(bus, ev));

  scope.events.on("player_spawn", (ev) => {
    const slot = ev.getPlayerSlot("userid");
    if (slot >= 0) onSpawn(slot);
  });

  // Suppress the client broadcast for a team change TTT is about to undo. `Handled` stops the
  // "X has joined the Spectators" notification reaching clients; the server still applies the
  // change, which the post-event handler below reverses. Splitting it this way means the switch is
  // issued exactly once, while the leak — a dead player's team move announcing their death — never
  // reaches anybody.
  scope.events.onPre("player_team", (ev): HookResultValue | void => {
    const slot = ev.getPlayerSlot("userid");
    if (wouldRefuseTeam(slot, ev.getInt("team") as Team, ev.getBool("disconnect"))) {
      return HookResult.Handled;
    }
  });

  scope.events.on("player_team", (ev) => {
    const slot = ev.getPlayerSlot("userid");
    // A leaving player fires `player_team` for team None on the way out; the flag lets the team
    // guard tell that apart from a live player ducking to spectator, which it must undo.
    onTeamChange(slot, ev.getInt("team") as Team, ev.getBool("disconnect"));
    // A team change alters who is eligible; re-derive liveness and re-check the round.
    reg.resyncAlive();
    checkEndConditions();
  });

  scope.events.on("round_start", () => {
    // Re-assert the required settings here as well as on map start: the map's own `gamemode_*.cfg`
    // execs AFTER `onMapStart`, so anything set there is overwritten (`mp_warmuptime` in
    // particular, which would otherwise keep the server in a warmup TTT never starts a round from).
    applyServerSettings();
    // Same reason the settings are re-applied here: the map's buy zones are not spawned yet at
    // `onMapStart`, so this is the first point at which they can actually be found and removed.
    removeBuyZones();
    invalidatePawnCache();
    onEngineRoundStart();
    serveQueuedSlays();
  });

  // Warmup blocks the round start; pick it back up the moment warmup finishes.
  scope.events.on("warmup_end", () => {
    syncRosterAndAnnounce();
    if (game.state === GameState.Waiting) startGame();
  });

  // The engine's own round end must not decide a TTT round, but it does restart the round out from
  // under us — so suppress the broadcast AND fold the TTT round up behind it.
  scope.events.onPre("round_end", (): HookResultValue | void => {
    if (game.state !== GameState.InProgress) return;
    onEngineRoundEnd();
    return HookResult.Handled;
  });

  // A resolved bomb frees up a C4 slot for the "max at once" purchase gate.
  scope.events.on("bomb_exploded", () => releaseC4());
  scope.events.on("bomb_defused", () => releaseC4());

  // Grenade detonations drive the Poison Smoke and Cluster Grenade items.
  scope.events.on("smokegrenade_detonate", (ev) => {
    // The projectile index is what lets the poison cloud die with the smoke that carries it,
    // rather than running out a fixed lifetime the map's own smoke never agreed to.
    onSmokeDetonate(
      ev.getPlayerSlot("userid"),
      ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"),
      ev.getInt("entityid"),
    );
  });

  // The poison goes when the cloud does.
  scope.events.on("smokegrenade_expired", (ev) => {
    onSmokeExpired(ev.getInt("entityid"));
  });

  scope.events.on("hegrenade_detonate", (ev) => {
    onHeDetonate(ev.getPlayerSlot("userid"), ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"));
  });

  // Poison Shots burns a charge on every pistol trigger pull, hit or miss — the C# spent the charge
  // on FIRE and only READ the counter on damage, so the shot that spends the last one lands clean.
  scope.events.on("weapon_fire", (ev) => {
    onWeaponFire(ev.getPlayerSlot("userid"), ev.getString("weapon"));
  });

  // Placed gadgets are shootable: a bullet pops a tripwire or takes a station's health down.
  scope.events.on("bullet_impact", (ev) => {
    onBulletImpact(ev.getPlayerSlot("userid"), ev.getFloat("x"), ev.getFloat("y"), ev.getFloat("z"));
  });

  scope.events.onPre("item_purchase", (ev): HookResultValue | void => {
    const slot = ev.getPlayerSlot("userid");
    if (slot < 0) return;
    return onItemPurchase(slot, ev.getString("weapon")) ? HookResult.Handled : undefined;
  });

  // Prefer refusing the grant at CanAcquire. Nested vote folding is still broken on some hosts,
  // so `item_purchase` above remains the strip fallback.
  items.onCanAcquire(onCanAcquire);

  // A weapon inspect identifies a corpse too, alongside USE — the C# routes both buttons into the
  // one `onStartUse` trace (`PropMover.cs:53`). Driven off the event rather than the button bit
  // because `PlayerButtons.Inspect` is `1 << 35` and will not survive a JS bitwise test; see
  // `inspectIdentify`.
  scope.events.on("inspect_weapon", (ev) => inspectIdentify(ev.getPlayerSlot("userid")));

  // ── entity + damage ───────────────────────────────────────────────────────
  // Per-PAWN, not a global mux: the damage hook is an `SDKHook` on each `player` entity now.
  // Seed the pawns that already exist (a hot reload mid-round), then catch every later one at
  // CREATE rather than spawn — a pawn is created first, so this cannot miss damage taken in the
  // spawn frame itself.
  for (const pawn of Entity.findByClass("player")) hookDamage(pawn);
  scope.entities.onCreate("player", (entity) => hookDamage(entity));
  // Fallback while the pre-hook does not receive real combat damage — see `onPlayerHurt`.
  scope.events.on("player_hurt", (ev) => onPlayerHurt(bus, ev));

  // ── map lifecycle ─────────────────────────────────────────────────────────
  scope.server.onPrecache((pc) => {
    precacheBodyModels(pc);
    precacheRoleModels(pc);
    precacheEffectModels(pc);
  });

  scope.server.onMapStart(() => {
    // Hide-then-Kill-then-restore, including name tags. Must run BEFORE `seedFromEngine` or
    // "[T] Bob" is cached as Bob's real name.
    teardownWorld(bus, "map");
    resetBuyMenu();
    resetRdmFlow();
    reg.seedFromEngine();
    // Only clears the one-shot latch — the zones themselves are not spawned yet, so the removal
    // proper waits for `round_start`.
    resetBuyZones();
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
  scope.server.onGameFrame(() => { tickSpoof(); }, { phase: "post" });

  scope.server.onGameFrame(() => {
    // FIRST, and before anything reads entity state: run work deferred to "next frame, pre-simulation"
    // (the `Server.NextWorldUpdate` equivalent). This subscription passes no `phase`, and core defaults
    // a subscription to Pre — which is the whole point. See core/preframe.ts.
    drainPreFrame();
    const now = Server.gameTime;
    const dt = now - lastTime;
    lastTime = now;
    // A map change rewinds the clock; skip the frame rather than feeding a bad dt onwards.
    if (dt <= 0 || dt > 1) return;

    tickHandlers(dt);
    tickWaiting(dt);
    tickCountdown(dt);
    // ABOVE the early return: pressing B outside a live round must still be answered ("the shop is
    // currently closed") rather than silently doing nothing.
    tickBuyMenu(dt);
    // ALSO above the early return. A victim is asked about a kill that may have ended the round, so
    // their prompt has to be able to expire in a state the round is no longer running in.
    tickRdmFlow();
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
  // Panorama HUD (traitor badge + clickable shop). Constructed before commands so `!shop` can
  // reach it. Degrades to nothing for players without the workshop addon — see cs2/ttthud.ts.
  const ui = new TttHud(
    (line) => console.log(`[ttt/ui] ${line}`),
    (slot) => Admin.forSlot(slot)?.hasFlags(ADMFLAG.GENERIC) ?? false,
  );
  setTttHud(ui);
  // A Guilty verdict queues slays rather than killing now: the accused is usually dead or gone by
  // the time an admin rules, and a slay that lands on nobody is the same as no punishment at all.
  ui.onGuilty = (steamId, name, slays, admin) => {
    // Advance the ladder BEFORE queueing, so the number an admin was shown is the number served and
    // the NEXT verdict against this person starts one rung higher.
    const priors = recordGuilty(steamId);
    const total = queueSlays(steamId, name, slays);
    console.log(
      `[ttt/rdm] ${admin} queued ${slays} slay(s) for ${name} (${total} owed, offence #${priors})`,
    );
    tellAll(`[ttt] ${name} was found guilty of RDM — ${total} slay(s) queued.`);
  };
  ui.onBan = (steamId, name, admin) => {
    if (steamId === "") {
      console.log(`[ttt/rdm] ${admin} tried to ban ${name} but no SteamID was recorded`);
      return;
    }
    // PERMANENT (minutes <= 0) and persisted to bans.json by the SDK. An admin who wants a
    // temporary ban has the basebans commands; this button exists for the clear-cut case.
    Bans.add(steamId, 0, `RDM (banned by ${admin})`);
    // The debt dies with the ban — they are not coming back to serve it, and leaving it queued
    // would slay whoever the SteamID belonged to if the ban is ever lifted.
    pardon(steamId);
    // Kick them if they are still here. A ban that leaves the player on the server until the next
    // map is a ban nobody watching believes happened.
    for (const slot of reg.activeSlots()) {
      if (reg.steamIdOf(slot) !== steamId) continue;
      Clients.fromSlot(slot)?.kickWithReason(`Banned for RDM by ${admin}`);
      break;
    }
    console.log(`[ttt/rdm] ${admin} BANNED ${name} (${steamId})`);
    tellAll(`[ttt] ${name} was banned for RDM.`);
  };

  registerCommands();
  command.onClientCommand("jointeam", onJoinTeamCommand);
  installRdmFlow(bus);
  // The victim's next chat line IS the report reason, so it is intercepted rather than read: a
  // reason broadcast to the server tells the accused exactly what was said and by whom.
  // `captureSay` returns false for every message that is not an awaited one, which is nearly all
  // of them — those fall through untouched.
  for (const cmd of ["say", "say_team"]) {
    command.onClientCommand(cmd, (slot, argString) => {
      // The engine hands `say` its argument quoted; the quotes are not part of what was typed.
      const text = argString.trim().replace(/^"(.*)"$/s, "$1");
      return captureSay(slot, text) ? HookResult.Handled : HookResult.Continue;
    });
  }

  console.log("[ttt] loaded — Trouble in Terrorist Town");

}

/** Best-effort cleanup. The ledger is still the teardown authority; this restores the WORLD. */
export function OnPluginEnd(): void {
  teardownWorld(bus, "unload");
}

/**
 * Arm the per-entity damage hook on one player pawn.
 *
 * `false` back from `SDKHook` means the ref was null or already stale — a pawn that died inside the
 * same frame it spawned. Nothing to do about it and nothing worth logging per spawn.
 */
function hookDamage(pawn: EntityRef | null): void {
  SDKHook(pawn, SDKHookType.OnTakeDamage, (info) => onDamage(bus, info));
}

/**
 * Serve one queued RDM slay per sanctioned player, at round start.
 *
 * `pawn.slay()` now fires `player_death` synchronously — the engine call is wrapped in an outbound
 * nest token, so TTT's own `player_death` onPre runs before `slay()` returns. What it does NOT do
 * here is mark the player dead in the registry: at `round_start` the game state is still
 * Waiting/Countdown, so `onDeathPre` takes its `!inProgress()` early return. Hence the explicit
 * `resyncAlive()` below rather than waiting on the 1 Hz reconcile.
 *
 * A player with no pawn yet keeps the debt for next round rather than having it forgiven.
 */
function serveQueuedSlays(): void {
  // `.map` already copies, so a nested handler splicing the registry cannot shift this walk.
  const connected = reg.activeSlots().map((slot: number) => ({ slot, steamId: reg.steamIdOf(slot) }));
  const served = serveRoundStart(connected, (slot) => {
    const pawn = pawnOf(slot);
    if (pawn === null || !reg.isAlive(slot)) return false;
    pawn.slay();
    return true;
  });
  reg.resyncAlive();
  for (const s of served) {
    // A nested death can carry the round to an end from inside this loop; stop talking about
    // sanctions for a round that is already over.
    if (game.state !== GameState.InProgress && game.state !== GameState.Countdown) break;
    tell(s.slot, `[ttt] Slain for RDM.${s.remaining > 0 ? ` ${s.remaining} slay(s) remaining.` : ""}`);
    // Say WHY they had no role this round. Being killed at the buzzer with no explanation reads as
    // a bug, and the exclusion from role selection is the half nobody can see.
    tell(s.slot, msg("RDM_SANCTION_BENCHED"));
  }
}
