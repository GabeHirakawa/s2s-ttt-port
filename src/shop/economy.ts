/**
 * Credit income — the port of `RoleAssignCreditor`, `PlayerKillListener`, `TaseRewarder`,
 * `PeriodicRewarder` and `RoundShopClearer`.
 *
 * `PeriodicRewarder` is the interesting one: it sampled every alive player's position every 5s into
 * a `Dictionary<string, List<Vector>>`, cloning a `Vector` per player per sample and trimming the
 * list with `RemoveAt(0)` (an O(n) shift), then every 30s ran a LINQ pipeline over all of it. Here
 * each player has a fixed-size ring buffer of coordinates in one shared `Float32Array`, and the
 * travelled distance is accumulated incrementally as samples land — the reward pass is then a
 * single sort of at most 64 numbers.
 */

import { Server } from "@s2script/sdk/server";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import { cfg, n } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { addBalance, balanceOf, resetShop } from "./shop";
import { karmaOf, MAX_KARMA } from "../karma/karma";
import { pawnOf } from "../cs2/pawn";
import { game } from "../game/game";

/** How many position samples each player keeps. */
const SAMPLES = 8;
/** Ring buffer of sampled positions: `[slot][sample] -> (x, y, z)`. */
const trail = new Float32Array(MAX_SLOTS * SAMPLES * 3);
/** Next write index into each player's ring. */
const trailHead = new Uint8Array(MAX_SLOTS);
/** How many valid samples each player has. */
const trailFill = new Uint8Array(MAX_SLOTS);
/** Accumulated squared distance travelled since the last reward pass. */
const travelled = new Float64Array(MAX_SLOTS);

/** Credits for a kill, by attacker/victim role — the C# `ShopConfig.CreditsForKill` table. */
function creditsForKill(attackerRole: RoleId, victimRole: RoleId): number {
  if (attackerRole === RoleId.None || victimRole === RoleId.None) return n("sm_ttt_shop_any_kill");
  switch (attackerRole) {
    case RoleId.Traitor:
      return victimRole === RoleId.Traitor ? n("sm_ttt_shop_traitor_v_traitor")
        : victimRole === RoleId.Detective ? n("sm_ttt_shop_traitor_v_detective")
        : n("sm_ttt_shop_traitor_v_inno");
    case RoleId.Detective:
      return victimRole === RoleId.Detective ? n("sm_ttt_shop_detective_v_detective")
        : victimRole === RoleId.Traitor ? n("sm_ttt_shop_detective_v_traitor")
        : n("sm_ttt_shop_detective_v_inno");
    case RoleId.Innocent:
      return victimRole === RoleId.Detective ? n("sm_ttt_shop_inno_v_detective")
        : victimRole === RoleId.Traitor ? n("sm_ttt_shop_inno_v_traitor")
        : n("sm_ttt_shop_inno_v_inno");
    default:
      return n("sm_ttt_shop_any_kill");
  }
}

/** Scale starting credits by karma, exactly as the C# `getKarmaScale` stepped it. */
function karmaScale(percent: number): number {
  if (percent >= 0.9) return 1;
  if (percent >= 0.8) return 0.9;
  if (percent >= 0.5) return 0.8;
  if (percent >= 0.3) return 0.5;
  return 0.25;
}

/** Record a position sample for one player, accumulating the distance from the previous sample. */
function sample(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null) return;
  const o = pawn.origin;
  if (o === null) return;

  const base = slot * SAMPLES * 3;
  const head = trailHead[slot]!;
  const fill = trailFill[slot]!;

  if (fill > 0) {
    const prev = base + ((head + SAMPLES - 1) % SAMPLES) * 3;
    const dx = o.x - trail[prev]!;
    const dy = o.y - trail[prev + 1]!;
    const dz = o.z - trail[prev + 2]!;
    travelled[slot] = travelled[slot]! + dx * dx + dy * dy + dz * dz;
  }

  const at = base + head * 3;
  trail[at] = o.x;
  trail[at + 1] = o.y;
  trail[at + 2] = o.z;
  trailHead[slot] = (head + 1) % SAMPLES;
  if (fill < SAMPLES) trailFill[slot] = fill + 1;
}

/** Clear one player's movement history. */
function clearTrail(slot: number): void {
  trailHead[slot] = 0;
  trailFill[slot] = 0;
  travelled[slot] = 0;
}

/** Reusable buffer for the reward ranking — avoids a per-pass array allocation. */
const ranking: number[] = [];

/**
 * Pay out exploration rewards: rank alive players by distance travelled and scale each reward
 * between the configured min and max by their rank.
 */
function payExplorationRewards(): void {
  if (game.state !== GameState.InProgress) return;

  ranking.length = 0;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (reg.isAlive(slot) && trailFill[slot]! > 1) ranking.push(slot);
  }
  if (ranking.length === 0) return;

  ranking.sort((a, b) => travelled[b]! - travelled[a]!);

  const min = n("sm_ttt_shop_reward_min");
  const max = n("sm_ttt_shop_reward_max");
  const count = ranking.length;
  const reason = msg("SHOP_EXPLORATION");
  for (let i = 0; i < count; i++) {
    const slot = ranking[i]!;
    // Rank 0 (most movement) gets `max`; the least-moved gets `min`.
    const position = count === 1 ? 1 : (count - i - 1) / (count - 1);
    addBalance(slot, Math.ceil(min + (max - min) * position), reason);
    travelled[slot] = 0;
  }
}

let sampleAccum = 0;
let rewardAccum = 0;

/**
 * Drive the periodic samplers. Called from the plugin's single shared frame tick with the elapsed
 * seconds, so there is exactly one frame callback for the whole plugin rather than the C#'s
 * several independent `SchedulePeriodic` timers.
 */
export function tickEconomy(dt: number): void {
  if (game.state !== GameState.InProgress) return;

  sampleAccum += dt;
  if (sampleAccum >= 5) {
    sampleAccum = 0;
    const active = reg.activeSlots();
    for (let i = 0; i < active.length; i++) {
      const slot = active[i]!;
      if (reg.isAlive(slot)) sample(slot);
    }
  }

  rewardAccum += dt;
  const interval = n("sm_ttt_shop_reward_interval");
  if (rewardAccum >= interval) {
    rewardAccum = 0;
    payExplorationRewards();
  }
}

/** Register every income/expenditure listener. */
export function installEconomy(bus: EventBus<TttEvents>): void {
  // Starting credits, scaled by karma.
  bus.on("roleAssigned", (ev) => {
    if (ev.role === RoleId.Spectator) return;
    const base = cfg.roleCredits[ev.role] ?? 0;
    if (base === 0) return;
    const percent = (karmaOf(ev.slot) + cfg.karmaMin) / MAX_KARMA;
    addBalance(ev.slot, Math.ceil(base * karmaScale(percent)), "Round Start", false);
  }, { priority: Priority.LOW });

  // Kill rewards.
  bus.on("death", (ev) => {
    if (game.state !== GameState.InProgress) return;
    const killer = ev.killer;
    if (killer < 0 || killer === ev.slot) return;

    const victimRole = reg.roleOf(ev.slot);
    let killerCredits = creditsForKill(reg.roleOf(killer), victimRole);
    const assister = ev.assister;
    if (assister >= 0 && assister !== killer) {
      const assistCredits = Math.trunc(
        creditsForKill(reg.roleOf(assister), victimRole) * n("sm_ttt_shop_assist_multiplier"),
      );
      addBalance(assister, assistCredits, `Assisted on ${reg.nameOf(ev.slot)}`);
    } else {
      killerCredits = Math.trunc(killerCredits * n("sm_ttt_shop_solo_kill_multiplier"));
    }
    addBalance(killer, killerCredits, `Killed ${reg.nameOf(ev.slot)}`);

    // The victim's remaining balance is partly inherited by the killer, as in the C#.
    const victimBalance = balanceOf(ev.slot);
    if (victimBalance > 0) addBalance(killer, (victimBalance / 2) | 0, "Loot");

    clearTrail(ev.slot);
  });

  // Body identification pays the finder, and settles up with the killer.
  bus.on("bodyIdentify", (ev) => {
    if (ev.canceled || ev.identifier < 0) return;
    const body = ev.body;
    const victimBalance = balanceOf(body.owner);
    addBalance(ev.identifier, (victimBalance / 4) | 0, `Identified ${body.ownerName}`);

    const killer = body.killer;
    if (killer < 0 || !reg.isConnected(killer)) return;
    const goodKill = (reg.roleOf(killer) === RoleId.Traitor) !== (body.ownerRole === RoleId.Traitor);
    if (goodKill) {
      addBalance(killer, (victimBalance / 4) | 0, "Good Kill");
    } else {
      const killerBalance = balanceOf(killer);
      addBalance(killer, -(((killerBalance / 3) | 0) + ((victimBalance / 2) | 0)), "Bad Kill");
    }
  }, { ignoreCanceled: true });

  // A successful tase pays out and deals no damage.
  bus.on("damage", (ev) => {
    if (game.state !== GameState.InProgress) return;
    // Substring, for the same reason as the scan itself in effects.ts: `player_hurt` reports `taser`
    // while the pre-hook reports `weapon_taser`, so equality misses the live path.
    if (ev.attacker < 0 || !ev.weapon.includes("taser")) return;
    ev.canceled = true;
    addBalance(ev.attacker, 30, "Successful Tase");
  }, { priority: Priority.HIGH });

  // Wipe balances and per-round state when a round finishes.
  bus.on("gameState", (ev) => {
    if (ev.state === GameState.InProgress) {
      for (let i = 0; i < MAX_SLOTS; i++) clearTrail(i);
      sampleAccum = 0;
      rewardAccum = 0;
      return;
    }
    if (ev.state !== GameState.Finished) return;
    resetShop();
  }, { ignoreCanceled: true });

  bus.on("leave", (ev) => clearTrail(ev.slot));
}

/** Exposed for the Rich round, which needs the server clock without importing `Server` itself. */
export function now(): number {
  return Server.gameTime;
}
