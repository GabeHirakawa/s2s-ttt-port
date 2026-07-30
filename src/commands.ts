/**
 * Chat/console commands — the port of `CommandManager`, `TTTCommand`, `LogsCommand`,
 * `KarmaCommand`, `ShopCommand`, `BuyCommand`, `ListCommand`, `BalanceCommand` and the test
 * commands under `TTT/CS2/Command/Test`.
 *
 * The C# had its own command manager layered over CounterStrikeSharp's: a `Dictionary<string,
 * ICommand>` of DI-registered command objects, each with `Aliases`/`Usage`/`RequiredFlags`, an
 * async `Execute` returning a result enum the manager then translated into a reply. s2script's
 * `ctx.commands` already provides registration, chat triggers, admin gating and reply routing, so
 * commands here register directly against it.
 */

import type { CtxCommands } from "@s2script/sdk/plugin";
import type { CommandInvocation } from "@s2script/sdk/commands";
import { ADMFLAG, Admin } from "@s2script/sdk/admin";
import { ChatColors } from "@s2script/cs2";
import { GameState, MAX_SLOTS, RoleId } from "./core/enums";
import { cfg } from "./core/cvars";
import { msg, msgFor } from "./core/msgs";
import * as reg from "./core/registry";
import { getHealth, setHealth, teamOf, tell, tellAll } from "./cs2/pawn";
import { game, inWarmup, startGame, endGame } from "./game/game";
import { reserveRole, roleName, roleNameFor } from "./game/roles";
import { printLogsTo } from "./game/logger";
import { allBodies } from "./cs2/bodies";
import { Entity } from "@s2script/sdk/entity";
import { damageDiag, killWithGadget } from "./cs2/combat";
import { Voice } from "@s2script/sdk/voice";
import { Menu, MenuCancelReason, MenuStyle } from "@s2script/sdk/menu";
import { adminSetKarma, karmaOf, timeoutRemaining } from "./karma/karma";
import {
  addBalance, allItems, balanceOf, canPurchase, itemById, PurchaseResult, sortedFor, tryPurchase,
  type ShopItem,
} from "./shop/shop";
import { roundIds, startSpecialRounds } from "./special/rounds";

/** Reusable buffer for the shop listing — one allocation for the plugin's lifetime. */
const listBuffer: ShopItem[] = [];

// --- the shop menu ------------------------------------------------------------------------------
// Built on the SDK `Menu` rather than a bespoke "remember what I printed and watch chat for a
// digit" scheme, which is what this used to be. That matters for correctness, not just tidiness:
// `Menu` guarantees ONE open menu per slot and supersedes the previous one, so a player who opens
// the shop while the nominate menu is up cannot have a single "2" understood by both. A hand-rolled
// digit interceptor sits outside that guarantee and would double-fire against any other menu on the
// server.
//
// Pagination (7 per chat page), the number keys, the Exit control and the timeout all come from the
// framework too.

/** Open the shop menu for `slot`. Shared by `!shop`, `!list` and the ping shortcut. */
function openShopMenu(slot: number): void {
  if (slot < 0) return;
  if (game.state !== GameState.InProgress) {
    tell(slot, msgFor(slot, "SHOP_INACTIVE"));
    return;
  }
  const role = reg.roleOf(slot);
  if (role === RoleId.None) return;

  const items = sortedFor(slot, listBuffer);
  const bal = balanceOf(slot);
  tell(slot, msgFor(slot, "SHOP_LIST_FOOTER", roleName(role), bal));
  if (items.length === 0) return;

  const m = new Menu(msgFor(slot, "SHOP_MENU_TITLE"));
  m.style = MenuStyle.Chat; // non-freezing: the player is mid-round and being hunted
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // Unaffordable and role-locked items stay VISIBLE but disabled, for the same reason cooldown
    // maps stay in the nominate menu: a catalogue that silently omits things cannot be learned from.
    // `disabled` also keeps them off the number keys, so nothing is bought by accident.
    // The chat menu renderer prints each line through Chat.toSlot, so colour bytes in the DISPLAY
    // string render as they would in any other chat line. Price in amber, name in green when it can
    // be bought and red when it cannot — the same read as the old flat listing.
    const ok = canPurchase(slot, item) === PurchaseResult.Success && item.price <= bal;
    const name = msgFor(slot, item.nameKey);
    const price = `${ChatColors.Grey}[${ChatColors.Yellow}${item.price}${ChatColors.Grey}]`;
    m.addItem(
      item.id,
      ok
        ? `${price} ${ChatColors.Green}${name}`
        : `${ChatColors.Grey}[${ChatColors.DarkRed}${item.price}${ChatColors.Grey}] ${ChatColors.Red}${name} - (cannot afford)`,
      { disabled: !ok },
    );
  }

  m.onSelect((e) => {
    const item = itemById(e.info);
    if (item === undefined) return;
    // Re-validated here rather than trusted from display time: credits and liveness can both have
    // changed between the menu being painted and the number being typed.
    if (game.state !== GameState.InProgress || !reg.isAlive(e.slot)) {
      tell(e.slot, msgFor(e.slot, "SHOP_INACTIVE"));
      return;
    }
    if (tryPurchase(e.slot, item) !== PurchaseResult.Success) return; // prints its own refusal
    tell(e.slot, msgFor(e.slot, "SHOP_PURCHASED", msgFor(e.slot, item.nameKey)));
    const desc = msg(item.descKey);
    if (desc !== "" && desc !== item.descKey) {
      tell(e.slot, msgFor(e.slot, "SHOP_PURCHASED_DETAIL", desc));
    }
  });

  m.onCancel((e) => {
    // Only the two closes the PLAYER caused are worth a word. `NewMenu` means they opened something
    // else and are looking at it — telling them the shop closed would be noise about a thing they
    // just did on purpose — and `Disconnect` has nobody left to tell.
    if (e.reason === MenuCancelReason.Exit) tell(e.slot, msgFor(e.slot, "SHOP_MENU_CLOSED"));
    else if (e.reason === MenuCancelReason.Timeout) tell(e.slot, msgFor(e.slot, "SHOP_MENU_EXPIRED"));
  });

  m.display(slot, MENU_SECONDS);
  openMenus[slot] = m;
}

/** How long the shop menu stays open with no selection. */
const MENU_SECONDS = 30;

/** The live shop menu per slot, so a round boundary can close it. */
const openMenus: (Menu | null)[] = new Array<Menu | null>(MAX_SLOTS).fill(null);

/**
 * Close every open shop menu — round boundary and map change.
 *
 * A menu printed last round must not stay answerable into this one: its contents came from the old
 * role and balance, so a stale number would buy something the player never saw offered.
 */
export function resetShopMenus(): void {
  for (let i = 0; i < MAX_SLOTS; i++) {
    const m = openMenus[i];
    if (m !== null) m.close(i);
    openMenus[i] = null;
  }
}

/** Open the shop from a middle-mouse ping. */
export function onPlayerPing(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  if (game.state !== GameState.InProgress || !reg.isAlive(slot)) return;
  openShopMenu(slot);
}

/** The version string reported by `!ttt`. */
const VERSION = "0.1.0";

/** Register every command on the plugin context. */
export function registerCommands(commands: CtxCommands): void {
  commands.register("sm_ttt", (cmd) => {
    if (cmd.arg(0).toLowerCase() !== "status") {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_TTT", VERSION));
      return;
    }
    // `ttt` is a public command, but `ttt status` lists every player's ROLE — handing that to any
    // player would give away the whole game. Admins and the server console only.
    if (!isAdmin(cmd.callerSlot)) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_NO_PERMISSION"));
      return;
    }

    // A plain-text dump of the round state — the operator's window into what the plugin thinks is
    // happening; TTT's own chat output is invisible from an rcon console.
    const states = ["WAITING", "COUNTDOWN", "IN_PROGRESS", "FINISHED"];
    const active = reg.activeSlots();
    cmd.reply(
      `[ttt] state=${states[game.state] ?? game.state} players=${active.length}/${cfg.minPlayers} ` +
        `warmup=${inWarmup()} participants=${game.participants} roundsThisMap=${game.roundsThisMap}`,
    );
    cmd.reply(
      `[ttt] alive: innocent=${reg.aliveCount(RoleId.Innocent)} ` +
        `traitor=${reg.aliveCount(RoleId.Traitor)} detective=${reg.aliveCount(RoleId.Detective)}`,
    );
    const bodies = allBodies();
    let live = 0;
    for (let i = 0; i < bodies.length; i++) if (bodies[i]!.ref.isValid()) live++;
    cmd.reply(
      `[ttt] bodies=${bodies.length} (live entities: ${live}, ` +
        `identified: ${bodies.filter((b) => b.identified).length})`,
    );
    cmd.reply(
      msgFor(
        cmd.callerSlot,
        "CMD_WORLD_ENTITIES",
        Entity.findByClass("point_worldtext").length,
        Entity.findByClass("prop_ragdoll").length,
        Entity.findByClass("prop_dynamic").length,
      ),
    );
    const d = damageDiag;
    cmd.reply(
      `[ttt] damage: preHook=${d.hits} fallback=${d.fallbackHits} ` +
        `canceled=${d.canceled} applied=${d.applied}`,
    );
    // `rewrites` is the effect counter: a voice rule that never rewrites is not doing anything.
    const v = Voice.stats();
    cmd.reply(
      v === null
        ? "[ttt] voice: unsupported on this runtime"
        : `[ttt] voice: calls=${v.calls} rules=${v.entries} rewrites=${v.rewrites}`,
    );
    for (let i = 0; i < active.length; i++) {
      const slot = active[i]!;
      cmd.reply(
        `  [${slot}] ${reg.nameOf(slot)} role=${roleName(reg.roleOf(slot)) || "none"}` +
          ` alive=${reg.isAlive(slot)}(engine:${reg.computeAlive(slot)})` +
          ` hp=${getHealth(slot)} team=${teamOf(slot)} credits=${balanceOf(slot)} karma=${karmaOf(slot)}`,
      );
    }
  });

  commands.register("sm_logs", (cmd) => {
    if (game.state !== GameState.InProgress && game.state !== GameState.Finished) {
      cmd.reply(msgFor(cmd.callerSlot, "GAME_LOGS_NONE"));
      return;
    }
    const slot = cmd.callerSlot;
    // Viewing the logs while alive is announced, exactly as the original did — it is an
    // information advantage the rest of the server is entitled to know about.
    if (slot >= 0 && reg.isAlive(slot)) {
      tellAll(msg("LOGS_VIEWED_ALIVE", reg.nameOf(slot)));
    } else if (slot >= 0) {
      cmd.reply(msgFor(cmd.callerSlot, "LOGS_VIEWED_INFO"));
    }
    printLogsTo(slot);
  });

  commands.register("sm_karma", (cmd) => {
    if (cmd.callerSlot < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_PLAYER_ONLY"));
      return;
    }
    cmd.reply(msgFor(cmd.callerSlot, "KARMA_COMMAND", karmaOf(cmd.callerSlot)));
  });

  // ── shop ──────────────────────────────────────────────────────────────────
  const balance = (cmd: CommandInvocation): void => {
    if (cmd.callerSlot < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_PLAYER_ONLY"));
      return;
    }
    cmd.reply(msgFor(cmd.callerSlot, "COMMAND_BALANCE", balanceOf(cmd.callerSlot)));
  };

  const list = (cmd: CommandInvocation): void => {
    const slot = cmd.callerSlot;
    // The shop opens with the round. Browsing during the countdown showed the catalogue before
    // anyone had a role, which both leaks the Traitor list and invites buying into a role you have
    // not been dealt. Console (slot < 0) still lists everything, for operators.
    if (slot >= 0 && game.state !== GameState.InProgress) {
      cmd.reply(msgFor(slot, "SHOP_INACTIVE"));
      return;
    }
    const items = slot < 0 ? (allItems() as ShopItem[]) : sortedFor(slot, listBuffer);
    const bal = slot < 0 ? Number.MAX_SAFE_INTEGER : balanceOf(slot);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const affordable =
        (slot < 0 || canPurchase(slot, item) === PurchaseResult.Success) && item.price <= bal;
      cmd.replyToChat(formatItem(item, i + 1, affordable));
    }

    if (slot < 0 || game.state !== GameState.InProgress) return;
    const role = reg.roleOf(slot);
    if (role === RoleId.None) return;
    cmd.replyToChat(msg("SHOP_LIST_FOOTER", roleName(role), bal));
  };

  const buy = (cmd: CommandInvocation, query = cmd.argsFrom(0).trim()): void => {
    const slot = cmd.callerSlot;
    if (slot < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_PLAYER_ONLY"));
      return;
    }
    if (game.state !== GameState.InProgress || !reg.isAlive(slot)) {
      cmd.reply(msgFor(cmd.callerSlot, "SHOP_INACTIVE"));
      return;
    }
    if (query === "") {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_USAGE", "buy <item>"));
      return;
    }

    const item = findItem(slot, query);
    if (item === undefined) {
      cmd.reply(msgFor(cmd.callerSlot, "SHOP_ITEM_NOT_FOUND", query));
      return;
    }
    if (tryPurchase(slot, item) !== PurchaseResult.Success) return;
    cmd.reply(msgFor(cmd.callerSlot, "SHOP_PURCHASED", msgFor(cmd.callerSlot, item.nameKey)));
    const desc = msg(item.descKey);
    if (desc !== "" && desc !== item.descKey) cmd.reply(msgFor(cmd.callerSlot, "SHOP_PURCHASED_DETAIL", desc));
  };

  commands.register("sm_balance", balance);
  commands.register("sm_bal", balance);
  commands.register("sm_credits", balance);
  commands.register("sm_points", balance);
  commands.register("sm_buy", buy);
  commands.register("sm_purchase", buy);
  commands.register("sm_b", buy);
  commands.register("sm_list", list);
  // `!shop`/`!list` from a player opens the interactive menu; the console still gets the plain dump.
  // The middle-mouse ping opens the shop — the one input a CS2 player has spare mid-round that
  // costs no keyboard hand, which matters in a mode where stopping to type is how you get shot.
  //
  // `player_ping` is a CLIENT CONSOLE COMMAND, not a game event: subscribing to a game event of
  // that name (the obvious-looking thing) receives nothing, because no such event is ever fired.
  // The C# hooked it with `AddCommandListener`, and `onClientCommand` is that same seam —
  // `register` cannot be used here, because the ENGINE already owns the name and refuses to link a
  // second ConCommand to it. Observe-only: no HookResult is returned, so the ping marker is still
  // placed exactly as normal.
  commands.onClientCommand("player_ping", (slot) => {
    onPlayerPing(slot);
  });

  commands.register("sm_menu", (cmd) => {
    if (cmd.callerSlot < 0) list(cmd);
    else openShopMenu(cmd.callerSlot);
  });

  commands.register("sm_shop", (cmd) => {
    const sub = cmd.arg(0).toLowerCase();
    switch (sub) {
      case "buy":
      case "purchase":
        buy(cmd, cmd.argsFrom(1).trim());
        return;
      case "balance":
      case "bal":
        balance(cmd);
        return;
      case "":
      case "list":
        if (cmd.callerSlot >= 0) openShopMenu(cmd.callerSlot);
        else list(cmd);
        return;
      default:
        cmd.reply(msgFor(cmd.callerSlot, "GENERIC_USAGE", "shop <list|buy [item]|balance>"));
    }
  });

  // ── admin ─────────────────────────────────────────────────────────────────
  commands.registerAdmin("sm_ttt_start", ADMFLAG.GENERIC, (cmd) => {
    if (game.state !== GameState.Waiting) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_ERROR", "A round is already running"));
      return;
    }
    startGame();
    cmd.reply(msgFor(cmd.callerSlot, "CMD_ROUND_STARTING"));
  });

  commands.registerAdmin("sm_ttt_end", ADMFLAG.GENERIC, (cmd) => {
    if (game.state !== GameState.InProgress && game.state !== GameState.Countdown) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_ERROR", "No round is running"));
      return;
    }
    endGame(RoleId.None, "Ended by an admin");
    cmd.reply(msgFor(cmd.callerSlot, "CMD_ROUND_ENDED"));
  });

  commands.registerAdmin("sm_ttt_special", ADMFLAG.GENERIC, (cmd) => {
    const id = cmd.arg(0).toLowerCase();
    if (id === "") {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_SPECIAL_AVAILABLE", roundIds().join(", ")));
      return;
    }
    const started = startSpecialRounds([id]);
    cmd.reply(started.length > 0 ? `Started: ${started.join(", ")}` : `Unknown round: ${id}`);
  });

  /**
   * `ttt_karma [target] [value]` — inspect or set karma.
   *
   * Setting karma also lifts any karma timeout the new value clears. Without this an operator has
   * no way to put a benched player back in: karma and the sit-out counter are separate state, and
   * the C# build exposed neither (its `!karma` only ever read your own).
   */
  commands.registerAdmin("sm_ttt_karma", ADMFLAG.GENERIC, (cmd) => {
    if (cmd.argCount === 0) {
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) {
        const slot = active[i]!;
        const out = timeoutRemaining(slot);
        cmd.reply(
          `  [${slot}] ${reg.nameOf(slot)} karma=${karmaOf(slot)}` +
            (out > 0 ? ` (benched ${out} more round${out === 1 ? "" : "s"})` : ""),
        );
      }
      cmd.reply(msgFor(cmd.callerSlot, "CMD_USAGE_KARMA"));
      return;
    }

    const slot = resolveTarget(cmd.arg(0));
    if (slot < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_NO_PLAYER_MATCH", cmd.arg(0)));
      return;
    }
    if (cmd.argCount < 2) {
      const out = timeoutRemaining(slot);
      cmd.reply(
        `[ttt] ${reg.nameOf(slot)} karma=${karmaOf(slot)}` +
          (out > 0 ? ` (benched ${out} more round${out === 1 ? "" : "s"})` : ""),
      );
      return;
    }

    const value = cmd.argInt(1, -1);
    if (value < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_USAGE", "ttt_karma <slot|name> <value>"));
      return;
    }
    adminSetKarma(slot, value);
    cmd.reply(
      `[ttt] ${reg.nameOf(slot)} karma set to ${karmaOf(slot)}` +
        (timeoutRemaining(slot) === 0 ? " (timeout cleared)" : ""),
    );
  });

  /** `ttt_give <target> <item>` — grant a shop item for free (port of the C# `GiveItemCommand`). */
  commands.registerAdmin("sm_ttt_give", ADMFLAG.GENERIC, (cmd) => {
    if (cmd.argCount === 0) {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_ITEM_LIST", allItems().map((i) => i.id).join(", ")));
      cmd.reply(msgFor(cmd.callerSlot, "CMD_USAGE_GIVE"));
      return;
    }
    const slot = resolveTarget(cmd.arg(0));
    if (slot < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_NO_PLAYER_MATCH", cmd.arg(0)));
      return;
    }
    const item = itemById(cmd.arg(1).toLowerCase());
    if (item === undefined) {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_UNKNOWN_ITEM", cmd.arg(1)));
      return;
    }
    item.onPurchase(slot);
    cmd.reply(
      msgFor(cmd.callerSlot, "CMD_GAVE_ITEM", msgFor(cmd.callerSlot, item.nameKey), reg.nameOf(slot)),
    );
  });

  /**
   * `ttt_roles` — who is who, coloured and grouped, printed to the caller's chat.
   *
   * `ttt status` answers the same question but is built for an rcon console: one dense line per
   * player, no colour. This is the in-game version — readable at a glance while spectating, which
   * is the only way to follow a round once you are dead.
   */
  commands.registerAdmin("sm_ttt_roles", ADMFLAG.GENERIC, (cmd) => {
    if (game.state !== GameState.InProgress && game.state !== GameState.Finished) {
      cmd.replyToChat(msg("GAME_LOGS_NONE"));
      return;
    }

    const active = reg.activeSlots();
    // Traitors first — they are what everyone is trying to work out.
    const order = [RoleId.Traitor, RoleId.Detective, RoleId.Innocent, RoleId.Spectator];
    let shown = 0;

    for (let r = 0; r < order.length; r++) {
      const role = order[r]!;
      const colour =
        role === RoleId.Traitor ? ChatColors.Red
        : role === RoleId.Detective ? ChatColors.Blue
        : role === RoleId.Innocent ? ChatColors.Green
        : ChatColors.Grey;

      for (let i = 0; i < active.length; i++) {
        const slot = active[i]!;
        if (reg.roleOf(slot) !== role) continue;
        const dead = !reg.isAlive(slot);
        cmd.replyToChat(
          ` ${colour}${roleName(role)}${ChatColors.Grey} - ` +
            `${dead ? ChatColors.Grey : ChatColors.Default}${reg.nameOf(slot)}` +
            `${dead ? ` ${ChatColors.DarkRed}[DEAD]` : ""}`,
        );
        shown++;
      }
    }
    if (shown === 0) cmd.replyToChat(msg("GAME_LOGS_NONE"));
  });

  /**
   * `sm_ttt_myrole <role>` — reserve your own role for the next assignment. ROOT only.
   *
   * Deliberately separate from `sm_ttt_setrole`, which rewrites someone's role in a LIVE round: this
   * one takes effect at the next deal, so the player goes through normal assignment and gets the
   * icons, uniform, glow and loadout that come with it. It also consumes a slot of that role's quota
   * rather than adding one, so the round's ratios stay honest.
   *
   * ROOT rather than GENERIC because choosing to be a Traitor is not moderation — it decides the
   * round for everyone in it.
   */
  /**
   * `sm_ttt_testkill <victim> [killer]` — kill someone and credit a Traitor for it. ROOT only.
   *
   * A testing aid for everything that keys off WHO killed WHOM: the DNA scanner, the corpse's killer
   * record, karma, the kill feed. Producing that state by hand otherwise means two people, two roles
   * and a real firefight.
   *
   * `killer` defaults to a living Traitor, since that is the case worth testing. It goes through
   * `markGadgetKill`, the same attribution path the tripwire and cluster fragments use, so the corpse
   * records a real killer rather than the suicide a bare health write would produce.
   */
  /**
   * `sm_ttt_credits <target> <amount>` — set someone's shop balance outright. ROOT only.
   *
   * A testing aid: role-gated items cost enough that trying one repeatedly means playing several
   * rounds to afford it. Goes through `addBalance` with the delta rather than writing the balance
   * directly, so the `balance` bus event still fires and anything listening stays consistent.
   */
  commands.registerAdmin("sm_ttt_credits", ADMFLAG.ROOT, (cmd) => {
    if (cmd.arg(0) === "" || cmd.arg(1) === "") {
      cmd.reply("usage: sm_ttt_credits <target> <amount>");
      return;
    }
    const slot = resolveTarget(cmd.arg(0));
    if (slot < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_NO_PLAYER_MATCH", cmd.arg(0)));
      return;
    }
    const want = Number.parseInt(cmd.arg(1), 10);
    if (!Number.isFinite(want) || want < 0) {
      cmd.reply(`'${cmd.arg(1)}' is not a credit amount`);
      return;
    }
    addBalance(slot, want - balanceOf(slot), "Admin", false);
    cmd.reply(`${reg.nameOf(slot)} now has ${String(balanceOf(slot))} credits`);
  });

  commands.registerAdmin("sm_ttt_testkill", ADMFLAG.ROOT, (cmd) => {
    if (cmd.arg(0) === "") {
      cmd.reply("usage: sm_ttt_testkill <victim> [killer]  (killer defaults to a live Traitor)");
      return;
    }
    const victim = resolveTarget(cmd.arg(0));
    if (victim < 0) {
      cmd.reply(msgFor(cmd.callerSlot, "CMD_NO_PLAYER_MATCH", cmd.arg(0)));
      return;
    }
    if (!reg.isAlive(victim)) {
      cmd.reply(`${reg.nameOf(victim)} is already dead`);
      return;
    }

    let killer = -1;
    if (cmd.arg(1) !== "") {
      killer = resolveTarget(cmd.arg(1));
      if (killer < 0) {
        cmd.reply(msgFor(cmd.callerSlot, "CMD_NO_PLAYER_MATCH", cmd.arg(1)));
        return;
      }
    } else {
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) {
        const slot = active[i]!;
        if (slot !== victim && reg.isAlive(slot) && reg.roleOf(slot) === RoleId.Traitor) {
          killer = slot;
          break;
        }
      }
      if (killer < 0) {
        cmd.reply("no living Traitor to credit — pass one explicitly: sm_ttt_testkill <victim> <killer>");
        return;
      }
    }
    if (killer === victim) {
      cmd.reply("killer and victim must differ, or the corpse records a suicide and carries no DNA");
      return;
    }

    killWithGadget(victim, killer, "[Test Kill]");
    cmd.reply(`killed ${reg.nameOf(victim)}, credited to ${reg.nameOf(killer)} (${roleName(reg.roleOf(killer))})`);
  });

  commands.registerAdmin("sm_ttt_myrole", ADMFLAG.ROOT, (cmd) => {
    const me = cmd.callerSlot;
    if (me < 0) {
      cmd.reply(msgFor(me, "CMD_MYROLE_NO_SLOT"));
      return;
    }
    const want = cmd.arg(0).toLowerCase();
    const role =
      want === "traitor" ? RoleId.Traitor
      : want === "detective" ? RoleId.Detective
      : want === "innocent" ? RoleId.Innocent
      : want === "none" || want === "clear" ? RoleId.Spectator
      : RoleId.None;
    if (role === RoleId.None) {
      cmd.reply(msgFor(me, "CMD_MYROLE_USAGE"));
      return;
    }
    // `Spectator` is the sentinel for "cancel" here, not a role anyone can reserve.
    if (role === RoleId.Spectator) {
      reserveRole(me, RoleId.None);
      cmd.reply(msgFor(me, "CMD_MYROLE_CLEARED"));
      return;
    }
    reserveRole(me, role);
    cmd.reply(msgFor(me, "CMD_MYROLE_SET", roleNameFor(me, role)));
  });

  commands.registerAdmin("sm_ttt_setrole", ADMFLAG.GENERIC, (cmd) => {
    const slot = cmd.argInt(0, -1);
    const roleName_ = cmd.arg(1).toLowerCase();
    const role =
      roleName_ === "traitor" ? RoleId.Traitor
      : roleName_ === "detective" ? RoleId.Detective
      : roleName_ === "innocent" ? RoleId.Innocent
      : RoleId.None;
    if (slot < 0 || !reg.isConnected(slot) || role === RoleId.None) {
      cmd.reply(msgFor(cmd.callerSlot, "GENERIC_USAGE", "ttt_setrole <slot> <innocent|traitor|detective>"));
      return;
    }
    reg.setRole(slot, role);
    cmd.reply(msgFor(cmd.callerSlot, "CMD_ROLE_SET", slot, roleNameFor(cmd.callerSlot, role)));
  });
}

/** Is this caller an admin? The server console (slot < 0) always is. */
function isAdmin(slot: number): boolean {
  if (slot < 0) return true;
  return Admin.forSlot(slot)?.hasFlags(ADMFLAG.GENERIC) === true;
}

/**
 * Resolve an admin command target: a slot number, an exact name, or a unique partial name.
 * Returns -1 when nothing (or more than one thing) matches.
 */
function resolveTarget(query: string): number {
  if (query === "") return -1;

  const asSlot = parseInt(query, 10);
  if (String(asSlot) === query && reg.isConnected(asSlot)) return asSlot;

  const active = reg.activeSlots();
  const lower = query.toLowerCase();
  for (let i = 0; i < active.length; i++) {
    if (reg.nameOf(active[i]!).toLowerCase() === lower) return active[i]!;
  }
  let found = -1;
  for (let i = 0; i < active.length; i++) {
    if (reg.nameOf(active[i]!).toLowerCase().includes(lower)) {
      if (found >= 0) return -1; // ambiguous
      found = active[i]!;
    }
  }
  return found;
}

/** Find an item by list index, exact name, partial name, then description. */
function findItem(slot: number, query: string): ShopItem | undefined {
  const items = sortedFor(slot, listBuffer);

  const index = parseInt(query, 10);
  if (Number.isFinite(index) && String(index) === query) {
    return index >= 1 && index <= items.length ? items[index - 1] : undefined;
  }

  const byId = itemById(query.toLowerCase());
  if (byId !== undefined) return byId;

  const lower = query.toLowerCase();
  for (let i = 0; i < items.length; i++) {
    if (msg(items[i]!.nameKey).toLowerCase() === lower) return items[i];
  }
  for (let i = 0; i < items.length; i++) {
    if (msg(items[i]!.nameKey).toLowerCase().includes(lower)) return items[i];
  }
  for (let i = 0; i < items.length; i++) {
    if (msg(items[i]!.descKey).toLowerCase().includes(lower)) return items[i];
  }
  return undefined;
}

/** Format one shop listing line, matching the original's colour scheme. */
function formatItem(item: ShopItem, index: number, affordable: boolean): string {
  const name = msg(item.nameKey);
  if (!affordable) {
    return ` ${ChatColors.Grey}- [${ChatColors.DarkRed}${item.price}${ChatColors.Grey}] ${ChatColors.Red}${name}`;
  }
  if (index > 9) {
    return ` ${ChatColors.Default}- [${ChatColors.Yellow}${item.price}${ChatColors.Default}] ${ChatColors.Green}${name}`;
  }
  return ` ${ChatColors.Blue}/${index} ${ChatColors.Default}| [${ChatColors.Yellow}${item.price}${ChatColors.Default}] ${ChatColors.Green}${name}`;
}
