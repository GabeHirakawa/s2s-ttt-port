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
import { GameState, RoleId } from "./core/enums";
import { cfg } from "./core/cvars";
import { msg, msgFor } from "./core/msgs";
import * as reg from "./core/registry";
import { getHealth, teamOf, tellAll } from "./cs2/pawn";
import { game, inWarmup, startGame, endGame } from "./game/game";
import { reserveRole, roleName, roleNameFor } from "./game/roles";
import { printLogsTo } from "./game/logger";
import { allBodies } from "./cs2/bodies";
import { Entity } from "@s2script/sdk/entity";
import { damageDiag } from "./cs2/combat";
import { Voice } from "@s2script/sdk/voice";
import { adminSetKarma, karmaOf, timeoutRemaining } from "./karma/karma";
import {
  allItems, balanceOf, canPurchase, itemById, PurchaseResult, sortedFor, tryPurchase,
  type ShopItem,
} from "./shop/shop";
import { roundIds, startSpecialRounds } from "./special/rounds";

/** Reusable buffer for the shop listing — one allocation for the plugin's lifetime. */
const listBuffer: ShopItem[] = [];

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
        list(cmd);
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
