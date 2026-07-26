/**
 * Assorted CS2 glue — the port of `PlayerMuter`, `AfkTimerListener`, `TraitorChatHandler`,
 * `NameDisplayer`, `BuyMenuHandler`, `MapZoneRemover`, `BombPlantSuppressor` and
 * `BodyPickupListener`'s announcement half.
 *
 * All of the periodic work here runs off the plugin's single shared frame handler with its own
 * accumulator, rather than one `AddTimer`/`SchedulePeriodic`/`RegisterListener<OnTick>` per feature
 * as in the C# build.
 */

import { Clients } from "@s2script/sdk/clients";
import { Voice } from "@s2script/sdk/voice";
import { Entity } from "@s2script/sdk/entity";
import { HookResult, type HookResultValue } from "@s2script/sdk/events";
import { UserMessages } from "@s2script/sdk/usermessages";
import { HintText, Player } from "@s2script/cs2";
import { TraceMask } from "@s2script/sdk/trace";
import { GameState, MAX_SLOTS, RoleId, Team } from "../core/enums";
import { cfg } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setArmor, setTakesDamage, tell, tellAll, toSpectator } from "./pawn";
import { weaponClass, type HeldWeapon } from "./inventory";
import { enforceRoundTeam, revealAsInnocent } from "../game/teams";
import { colorBody } from "./color";
import { unspoofAlive } from "./spoof";
import { game, inProgress, inWarmup } from "../game/game";
import { roleName } from "../game/roles";
import { logIdentify } from "../game/logger";
import { isCamouflaged } from "../shop/effects";
import { tryPurchase, itemById } from "../shop/shop";

/** Seconds each player has been stationary since the round started. */
const afkFor = new Float32Array(MAX_SLOTS);
/** Last sampled position, to detect movement without reading `hasMovedSinceSpawn` every frame. */
const lastX = new Float32Array(MAX_SLOTS);
const lastY = new Float32Array(MAX_SLOTS);
/** Whether an AFK warning has already been sent this round. */
const afkWarned = new Uint8Array(MAX_SLOTS);
/** Whether this slot currently carries a dead-player voice restriction. */
const deadMuted = new Uint8Array(MAX_SLOTS);

let nameAccum = 0;
let afkAccum = 0;

/**
 * Buy-menu weapons that map onto shop items. Buying one of these in the CS2 buy menu is redirected
 * into the TTT shop instead — the C# `BuyMenuHandler.shopAliases` table.
 */
const BUY_ALIASES: Readonly<Record<string, string>> = {
  item_assaultsuit: "armor",
  item_kevlar: "armor",
  weapon_taser: "taser",
  weapon_deagle: "deagle",
  weapon_smokegrenade: "poisonsmoke",
  weapon_m4a1_silencer: "m4a1",
  weapon_usp_silencer: "m4a1",
  weapon_sg556: "m4a1",
  weapon_mp5sd: "m4a1",
  weapon_awp: "silentawp",
  weapon_hegrenade: "clustergrenade",
  weapon_healthshot: "healthshot",
};

/** Whether this map's buy zones have already been removed — the `MapZoneRemover` latch. */
let zonesRemoved = false;

/**
 * Clear the once-per-map buy-zone latch. Called on map start.
 *
 * `MapZoneRemover.onMapStart` deliberately removes nothing here, and neither do we: map entities
 * need not exist yet when this fires, and the engine's round-restart cleanup re-creates map-placed
 * entities anyway — so a removal this early silently does nothing on most maps and the buy menu
 * survives for the whole map. {@link removeBuyZones} runs from `round_start` instead.
 */
export function resetBuyZones(): void {
  zonesRemoved = false;
}

/**
 * Remove the map's buy zones so the engine buy menu never opens. Driven from `round_start`, and
 * latched so it costs one entity scan per round and one removal pass per map.
 */
export function removeBuyZones(): void {
  if (zonesRemoved) return;
  const zones = Entity.findByClass("func_buyzone");
  // Do not burn the one-shot on a round that fired before the map's own entities existed; a map
  // with no buy zones at all just re-scans (a handful of pointer compares) each round.
  if (zones.length === 0) return;
  for (let i = 0; i < zones.length; i++) zones[i]!.remove();
  zonesRemoved = true;
}

/**
 * Suppress radio text, as `BombPlantSuppressor` did.
 *
 * The C# blocked user message **322**, which is `CS_UM_RadioText` (its siblings' `452` is
 * `CMsgTEFireBullets`, which pins the numbering space). That is what leaks the C4 planter: the
 * bomb-planted radio line names the planter, and TTT puts nearly everyone on the same team, so a
 * Traitor planting the shop C4 announces themselves to the server. Blocking the send for every
 * recipient is exactly `um.Recipients.Clear()`.
 */
export function installBombSuppressor(): void {
  try {
    UserMessages.onPre("CCSUsrMsg_RadioText", (): HookResultValue | void => HookResult.Handled);
  } catch (e) {
    // `onPre` throws at subscribe time on a name this build cannot resolve. Say so — swallowing it
    // silently reopens the role leak this module exists to plug.
    console.log(`[ttt] WARN: radio suppression unavailable: ${String(e)}`);
  }
}

/**
 * Grant kevlar **and** a helmet — the port of `SetArmor(config.Armor, config.Helmet)`, whose
 * `ArmorConfig.Helmet` shipped `true`.
 *
 * `CCSPlayer_ItemServices.m_bHasHelmet` is not in the generated schema, so the flag cannot be
 * written directly (the C# wrote it and needed a second `SetStateChanged` on the sub-object before
 * the client saw it at all). The engine's own grant path does both correctly, so the suit is given
 * first and the armour value pinned afterwards — `item_assaultsuit` sets its own amount, which need
 * not be what `css_ttt_shop_armor_amount` asks for.
 *
 * Role loadouts must NOT come through here: `CS2Player.Armor` passed `withHelmet: false`, so the
 * starting armour of every role is helmetless.
 */
export function giveArmorWithHelmet(slot: number, amount: number): void {
  pawnOf(slot)?.giveNamedItem("item_assaultsuit");
  setArmor(slot, amount);
  // The controller mirror the HUD reads for the helmet icon.
  const p = Player.fromSlot(slot);
  if (p !== null) p.pawnHasHelmet = true;
}

/**
 * Route a buy-menu purchase into the TTT shop. Returns true when the engine purchase should be
 * suppressed.
 */
export function onItemPurchase(slot: number, weapon: string): boolean {
  // `item_purchase` is a POST-grant notification: the engine has already handed the weapon over and
  // taken its own money, and `HookResult.Handled` only hides the event from other listeners. So the
  // engine's grant is stripped here first, exactly as `BuyMenuHandler.OnPurchase` did — otherwise a
  // buy zone that outlived `removeBuyZones` hands out free real weapons on top of the TTT loadout,
  // and an aliased buy whose shop purchase FAILS (wrong role, no credits, limit) is kept for free.
  //
  // Unlike the C#, the removal runs synchronously BEFORE `tryPurchase`. The original queued its
  // removals onto the next world update while the shop grant ran inline, so they landed after the
  // grant and destroyed the shop weapon too — replicating that leaves an M4A1 buyer with no rifle.
  const pawn = pawnOf(slot);
  if (pawn !== null && pawn.isValid) {
    const held = pawn.weapons as HeldWeapon[];
    for (let i = 0; i < held.length; i++) {
      const w = held[i]!;
      if (weaponClass(w) === weapon) {
        pawn.removeWeapon(w);
        break;
      }
    }
  }
  // Armour is not a weapon entity, so it has to be zeroed on the pawn instead. Like the C#, the
  // helmet flag is left alone — there is no way to clear it, and it grants nothing on its own.
  if (weapon === "item_assaultsuit" || weapon === "item_kevlar") setArmor(slot, 0);

  // The C#'s two extra "clear the whole gear slot" cases are deliberately not ported, for two
  // different reasons. `weapon_m4a1_silencer -> RemoveWeaponInSlot(0)` is redundant: the m4a1 shop
  // item this purchase routes to already clears slots 0,1 (`css_ttt_shop_m4a1_clear_slots`).
  // `weapon_revolver -> RemoveWeaponInSlot(1)` is NOT — the second case keys on weapon_revolver, and
  // only weapon_deagle has a shop alias, so it never reaches the deagle item's own pistol-slot
  // clear. It is dropped because destroying the player's loadout pistol on a buy that grants them
  // nothing is a C# bug, not because anything else covers it.

  const itemId = BUY_ALIASES[weapon];
  if (itemId === undefined) return false;
  const item = itemById(itemId);
  if (item === undefined) return false;
  tryPurchase(slot, item);
  return true;
}

/** Reusable receiver list for the voice rules — one allocation for the plugin's lifetime. */
const deadSlots: number[] = [];

/**
 * Dead players may only be heard by other dead players.
 *
 * This is what TTT actually wants and neither the previous implementation nor the C# original
 * managed: `PlayerMuter` set `VoiceFlags.Muted`, silencing the dead outright. `Voice.setAudibleTo`
 * expresses the real rule — the dead can still talk among themselves, the living just cannot hear
 * them — so death chat works without leaking information to players still in the round.
 *
 * Rules are declarative state, so this only writes when the dead set actually changes.
 */
function updateVoice(): void {
  if (!inProgress()) {
    if (voiceActive) clearVoiceRules();
    return;
  }

  // Rebuild the dead set and bail out unless it changed since the last pass.
  deadSlots.length = 0;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) deadSlots.push(slot);
  }
  if (!deadSetChanged()) return;

  for (let i = 0; i < deadSlots.length; i++) {
    const slot = deadSlots[i]!;
    Voice.setAudibleTo(slot, deadSlots);
    if (deadMuted[slot] === 0) {
      deadMuted[slot] = 1;
      tell(slot, msg("DEAD_MUTE_REMINDER"));
    }
  }
  // Anyone who came back alive gets handed back to the engine.
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    if (deadMuted[slot] === 1 && deadSlots.indexOf(slot) < 0) {
      Voice.reset(slot);
      deadMuted[slot] = 0;
    }
  }
  voiceActive = deadSlots.length > 0;
}

/** Previous dead-set signature, so an unchanged set costs one comparison. */
let lastDeadSignature = "";
let voiceActive = false;

function deadSetChanged(): boolean {
  const sig = deadSlots.join(",");
  if (sig === lastDeadSignature) return false;
  lastDeadSignature = sig;
  return true;
}

/** Drop every voice restriction (round end / map change / unload). */
export function unmuteAll(): void {
  clearVoiceRules();
}

function clearVoiceRules(): void {
  Voice.resetAll();
  deadMuted.fill(0);
  lastDeadSignature = "";
  voiceActive = false;
  // Clear any legacy blanket mute this plugin may have set on an earlier version.
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const client = Clients.fromSlot(slot);
    if (client !== null && client.voiceMuted) client.voiceMuted = false;
  }
}

/**
 * Show the name of whoever the player is looking at.
 *
 * The C# ran this at 4 Hz for every player with a full eye-position ray each time and no gating on
 * whether the viewer was even alive. Same cadence here, but dead players and camouflaged targets are
 * skipped, and the hint is only re-sent when the target changes.
 */
const lastNameTarget = new Int32Array(MAX_SLOTS).fill(-1);

function updateNames(): void {
  if (!cfg.showNames) return;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;

    const hit = pawn.aimTrace({ distance: 1024, mask: TraceMask.ShotHitbox });
    let target = -1;
    if (hit !== null && hit.didHit && hit.entity !== null) {
      const idx = hit.entity.index;
      const others = reg.activeSlots();
      for (let j = 0; j < others.length; j++) {
        const other = others[j]!;
        if (other === slot) continue;
        const otherPawn = pawnOf(other);
        if (otherPawn !== null && otherPawn.ref.index === idx) {
          target = other;
          break;
        }
      }
    }

    // Camouflage: a camouflaged player never surfaces through the name display.
    if (target >= 0 && isCamouflaged(target)) target = -1;

    if (target === lastNameTarget[slot]) continue;
    lastNameTarget[slot] = target;
    if (target >= 0) HintText.to(slot, reg.nameOf(target));
  }
}

/**
 * Move players who have not moved all round to spectator.
 *
 * Bots are exempt. A bot cannot act on an AFK warning, so on a bot-populated server every bot would
 * be benched a minute into the first round and the mode could never start another one. The C#
 * checked `HasMovedSinceSpawn` with no such exemption (and wrapped the team change in `#if !DEBUG`,
 * which suggests it bit them too).
 */
function updateAfk(dt: number): void {
  if (!inProgress()) return;
  const limit = cfg.afkSeconds;
  if (limit <= 0) return;

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    if (Clients.fromSlot(slot)?.isBot === true) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;

    const dx = o.x - lastX[slot]!;
    const dy = o.y - lastY[slot]!;
    if (dx * dx + dy * dy > 4) {
      lastX[slot] = o.x;
      lastY[slot] = o.y;
      afkFor[slot] = 0;
      afkWarned[slot] = 0;
      continue;
    }

    afkFor[slot] = afkFor[slot]! + dt;
    if (afkWarned[slot] === 0 && afkFor[slot]! >= limit / 2) {
      afkWarned[slot] = 1;
      tell(slot, msg("AFK_WARNING", Math.round(limit / 2)));
      continue;
    }
    if (afkFor[slot]! >= limit) {
      // Never bench someone if doing so would drop the round below the minimum to play — that
      // turns one idle player into a stalled server for everyone else.
      if (reg.playerCount() - 1 < cfg.minPlayers) {
        afkFor[slot] = 0;
        continue;
      }
      afkFor[slot] = 0;
      afkWarned[slot] = 0;
      toSpectator(slot);
      tell(slot, msg("AFK_MOVED"));
    }
  }
}

/** Reset the AFK bookkeeping at round start. */
export function resetAfk(): void {
  afkFor.fill(0);
  afkWarned.fill(0);
  lastNameTarget.fill(-1);
}

/**
 * Keep pawns invulnerable outside a live round.
 *
 * TTT leaves `mp_teammates_are_enemies 1` / `mp_friendlyfire 1` on permanently, so without this
 * players shoot each other dead during WAITING and the countdown, and then are not alive to be
 * dealt a role. Re-asserted continuously because a respawn resets the flag.
 */
function updateInvulnerability(): void {
  // Warmup is ordinary CS2 deathmatch — the original's `OutOfRoundCanceler` explicitly skipped it
  // (`if (RoundUtil.IsWarmup()) return;`), so leave the engine's own rules alone there.
  const vulnerable =
    inWarmup() || game.state === GameState.InProgress || game.state === GameState.Finished;
  if (vulnerable === lastVulnerable) return;
  lastVulnerable = vulnerable;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) setTakesDamage(active[i]!, vulnerable);
}

/** Last applied vulnerability, so the common case is one boolean compare. */
let lastVulnerable = true;

/** Re-apply invulnerability to a single slot (called after a respawn resets the flag). */
export function refreshInvulnerability(slot: number): void {
  setTakesDamage(
    slot,
    inWarmup() || game.state === GameState.InProgress || game.state === GameState.Finished,
  );
}

/** Advance the periodic handlers. Driven by the plugin's one shared frame callback. */
export function tickHandlers(dt: number): void {
  updateVoice();
  updateInvulnerability();

  nameAccum += dt;
  if (nameAccum >= 0.25) {
    nameAccum = 0;
    updateNames();
  }

  afkAccum += dt;
  if (afkAccum >= 1) {
    updateAfk(afkAccum);
    afkAccum = 0;
  }
}

/**
 * Traitor-only chat. A Traitor typing a message prefixed with `@` sends it to the other Traitors
 * instead of the server — the C# `TraitorChatHandler`.
 */
export function handleChat(slot: number, text: string): HookResultValue | void {
  if (!inProgress()) return;
  if (reg.roleOf(slot) !== RoleId.Traitor) return;
  if (!text.startsWith("@")) return;

  const body = text.slice(1).trim();
  if (body === "") return HookResult.Handled;

  const line = msg("TRAITOR_CHAT_FORMAT", reg.nameOf(slot), body);
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const other = active[i]!;
    if (reg.roleOf(other) === RoleId.Traitor) tell(other, line);
  }
  return HookResult.Handled;
}

/**
 * Enforce "no joining a live round" and "no switching sides once you are in one" — the port of
 * `TeamChangeHandler`.
 *
 * The C# hooked the `jointeam` client command and refused it outright while a round was running.
 * s2script has no client-command hook, so this reacts to the resulting `player_team` event instead:
 * a player who ends up on a playing team mid-round without having been dealt a role is put straight
 * back to spectator, and a player who already holds one is put back on the team their role entitles
 * them to. Same outcome, one event later.
 *
 * A player whose corpse has already been identified is exempt: they are publicly dead, so letting
 * them move to spectator (or be moved) reveals nothing. That exemption lives in `enforceRoundTeam`.
 */
export function onTeamChange(slot: number, newTeam: Team, disconnecting = false): void {
  if (!inProgress()) return;
  if (slot < 0 || !reg.isConnected(slot)) return;
  // A leaving player fires `player_team` for team None on the way out: there is nobody left to pin,
  // and bouncing a controller the engine is already tearing down achieves nothing.
  if (disconnecting) return;

  // Joining a playing team mid-round without a role = spawning into a round already in progress.
  if (newTeam === Team.Terrorist || newTeam === Team.CounterTerrorist) {
    if (reg.roleOf(slot) === RoleId.None) {
      toSpectator(slot);
      tell(slot, msg("LATE_JOIN_SPECTATE"));
      return;
    }
    // Already in the round: CT is this mode's "publicly confirmed innocent" signal, so a move
    // between playing teams forges or erases a reveal. The C# refused the command; undo it.
    enforceRoundTeam(slot, newTeam);
    return;
  }

  if (newTeam === Team.Spectator || newTeam === Team.None) {
    // Leaving to spectator mid-round while still holding a live role is a way to dodge being
    // killed, so it counts as a death — the C# dispatched a PlayerDeathEvent for exactly this.
    if (newTeam === Team.Spectator && reg.isAlive(slot) && reg.roleOf(slot) !== RoleId.None) {
      onSelfSpectate(slot);
    }
    // Dead or alive, a role-holder whose body has not been found must not sit in the spectator
    // list: it publicly announces the death the whole round is built on hiding.
    enforceRoundTeam(slot, newTeam);
  }
}

/** Set by the plugin so a mid-round move to spectator can be reported as a death. */
let onSelfSpectate: (slot: number) => void = () => undefined;

/** Wire the "went to spectator mid-round" handler. */
export function setSelfSpectateHandler(fn: (slot: number) => void): void {
  onSelfSpectate = fn;
}

/** Register the body-identification announcement and the round-boundary resets. */
export function installHandlers(bus: EventBus<TttEvents>): void {
  /**
   * No combat outside a live round — the port of `OutOfRoundCanceler`.
   *
   * TTT sets `mp_teammates_are_enemies 1` and `mp_friendlyfire 1` permanently, so without this
   * everyone can shoot everyone while WAITING or counting down, and players (or bots) kill each
   * other before roles are even dealt. Damage is allowed only once the round is IN_PROGRESS, or
   * afterwards while FINISHED. Warmup is left to the engine's own rules.
   *
   * HIGHEST priority so every other damage listener sees `canceled` and skips its own work.
   */
  bus.on(
    "damage",
    (ev) => {
      if (inWarmup()) return;
      if (game.state !== GameState.InProgress && game.state !== GameState.Finished) {
        ev.canceled = true;
      }
    },
    { priority: Priority.HIGHEST },
  );

  bus.on(
    "bodyIdentify",
    (ev) => {
      const body = ev.body;
      const role = body.ownerRole;
      if (role === RoleId.None) return;

      tellAll(
        msg(
          "BODY_IDENTIFIED",
          ev.identifier >= 0 ? reg.nameOf(ev.identifier) : "Someone",
          body.ownerName,
          roleName(role),
        ),
      );
      logIdentify(ev.identifier, body.ownerName, role);

      // The owner stops reading as alive now that their corpse has been found.
      // Tint the corpse with the role it turned out to be, so anyone walking past afterwards can
      // see at a glance that it has been identified and what it was.
      colorBody(body.ref, body.owner, role);

      // The owner stops reading as alive now that their corpse has been found, and a non-Traitor
      // is publicly revealed by the move to CT.
      if (reg.isConnected(body.owner)) {
        unspoofAlive(body.owner);
        revealAsInnocent(body.owner);
      }
    },
    { ignoreCanceled: true },
  );

  bus.on(
    "gameState",
    (ev) => {
      // Force the next tick to re-apply, whichever way the new state lands.
      lastVulnerable = !(ev.state === GameState.InProgress || ev.state === GameState.Finished);
      if (ev.state === GameState.InProgress) {
        resetAfk();
        return;
      }
      if (ev.state === GameState.Finished) unmuteAll();
    },
    { ignoreCanceled: true },
  );

  bus.on("leave", (ev) => {
    deadMuted[ev.slot] = 0;
    afkFor[ev.slot] = 0;
    lastNameTarget[ev.slot] = -1;
  });
}
