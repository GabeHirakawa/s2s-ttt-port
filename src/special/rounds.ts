/**
 * Special rounds — the port of `SpecialRoundStarter`, `SpecialRoundTracker` and the seven rounds
 * under `TTT/SpecialRound/Rounds`.
 *
 * Each C# round was a DI-registered `AbstractSpecialRound` subclass with its own config record
 * (re-loaded per property read) and its own `IStorage<T>` implementation. Here a round is one object
 * with `apply`/`clear` callbacks and a weight; the picker walks a small static array.
 *
 * Two rounds needed engine hooks the C# reached through CounterStrikeSharp internals:
 *   - **Pistol** hooked `CCSPlayer_ItemServices::CanAcquire` to refuse rifles. There is no vfunc
 *     hooking here, so it strips rifles on purchase/pickup instead — same outcome, one frame later.
 *   - **Suppressed** hooked user message 452 to drop pistol fire sounds. `UserMessages.onPre` does
 *     exactly this, by name.
 */

import { Server } from "@s2script/sdk/server";
import { GameRules } from "@s2script/cs2";
import { GameState, RoleId } from "../core/enums";
import { n } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { tell, tellAll } from "../cs2/pawn";
import { clearSlot, GearSlot, RIFLES, heldWeapons, weaponClass } from "../cs2/inventory";
import { game, setRoundDeadline } from "../game/game";
import { addBalance, balanceOf } from "../shop/shop";
import { setSuppressPistols } from "../shop/weaponfx";

/** A special round definition. */
interface SpecialRound {
  id: string;
  name: string;
  descKey: string;
  /** Selection weight; 0 disables the round. */
  weight: number;
  /** Ids this round refuses to stack with. */
  conflicts?: readonly string[];
  /** Turn the round's effect on. */
  apply: () => void;
  /** Turn it off (always called at round end, even if `apply` never ran). */
  clear?: () => void;
}

/** Ids currently active. Small enough that `indexOf` beats a `Set`. */
const activeRounds: string[] = [];
/** Rounds since the last special round. */
let sinceSpecial = 0;

/** Is a given special round live? */
export function isActive(id: string): boolean {
  return activeRounds.indexOf(id) >= 0;
}

// ── Speed ────────────────────────────────────────────────────────────────────
/**
 * Extend the Speed round clock when an Innocent dies — the Traitors' incentive to keep killing.
 * This re-arms the real round deadline, not just the HUD clock.
 */
function speedOnKill(victimRole: RoleId): void {
  if (!isActive("speed") || victimRole !== RoleId.Innocent) return;
  const remaining = GameRules.get()?.timeRemaining ?? 0;
  const next = Math.min(remaining + n("sm_ttt_special_speed_per_kill"), n("sm_ttt_special_speed_max"));
  setRoundDeadline(next);
}

// ── Low gravity ──────────────────────────────────────────────────────────────
let originalGravity = "800";

// ── the catalogue ────────────────────────────────────────────────────────────
const ROUNDS: readonly SpecialRound[] = [
  {
    id: "bhop",
    name: "BHop",
    descKey: "SPECIAL_ROUND_BHOP",
    weight: 0.25,
    apply() {
      Server.command("sv_enablebunnyhopping 1");
      Server.command("sv_autobunnyhopping 1");
    },
    clear() {
      Server.command("sv_enablebunnyhopping 0");
      Server.command("sv_autobunnyhopping 0");
    },
  },
  {
    id: "lowgrav",
    name: "Low Grav",
    descKey: "SPECIAL_ROUND_LOWGRAV",
    weight: 0.6,
    apply() {
      originalGravity = Server.getCvar("sv_gravity") || "800";
      const base = parseFloat(originalGravity);
      const scaled = Math.round((Number.isFinite(base) ? base : 800) * n("sm_ttt_special_lowgrav_multiplier"));
      Server.setCvar("sv_gravity", String(scaled));
    },
    clear() {
      Server.setCvar("sv_gravity", originalGravity);
    },
  },
  {
    id: "pistol",
    name: "Pistol",
    descKey: "SPECIAL_ROUND_PISTOL",
    weight: 0.75,
    apply() {
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) clearSlot(active[i]!, GearSlot.Rifle);
    },
  },
  {
    id: "suppressed",
    name: "Suppressed",
    descKey: "SPECIAL_ROUND_SUPPRESSED",
    weight: 0.75,
    // Silencing runs through the single shared fire-sound interception in `weaponfx`, which the
    // Silent AWP also uses — the C# hooked user message 452 separately from each, and re-hooked
    // and unhooked it on every round transition.
    apply() {
      setSuppressPistols(true);
    },
    clear() {
      setSuppressPistols(false);
    },
  },
  {
    id: "vanilla",
    name: "Vanilla",
    descKey: "SPECIAL_ROUND_VANILLA",
    weight: 0.5,
    conflicts: ["rich"],
    apply() {
      /* the purchase listener does the work */
    },
  },
  {
    id: "rich",
    name: "Rich",
    descKey: "SPECIAL_ROUND_RICH",
    weight: 0.75,
    conflicts: ["vanilla"],
    apply() {
      // Starting credits are granted during role assignment, which runs before this round is marked
      // active — so top them up directly rather than trying to intercept that grant.
      const mult = n("sm_ttt_special_rich_bonus_multiplier");
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) {
        const slot = active[i]!;
        const bal = balanceOf(slot);
        if (bal <= 0) continue;
        const bonus = Math.trunc(bal * (mult - 1));
        if (bonus !== 0) addBalance(slot, bonus, RICH_BONUS, false);
      }
    },
  },
  {
    id: "speed",
    name: "Speed",
    descKey: "SPECIAL_ROUND_SPEED",
    weight: 1,
    apply() {
      setRoundDeadline(n("sm_ttt_special_speed_initial"));
    },
  },
];

const RICH_BONUS = "Rich Round Bonus";

/** Reusable buffer for the weighted pick. */
const candidates: SpecialRound[] = [];

/** Pick one round by weight, excluding anything already chosen or in conflict with it. */
function pickWeighted(): SpecialRound | null {
  candidates.length = 0;
  let total = 0;
  for (let i = 0; i < ROUNDS.length; i++) {
    const r = ROUNDS[i]!;
    if (r.weight <= 0 || activeRounds.indexOf(r.id) >= 0) continue;
    if (conflicts(r)) continue;
    candidates.push(r);
    total += r.weight;
  }
  if (candidates.length === 0 || total <= 0) return null;

  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= candidates[i]!.weight;
    if (roll <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}

/** Does `r` conflict with anything already active (in either direction)? */
function conflicts(r: SpecialRound): boolean {
  for (let i = 0; i < activeRounds.length; i++) {
    const activeId = activeRounds[i]!;
    if (r.conflicts?.includes(activeId) === true) return true;
    const other = ROUNDS.find((x) => x.id === activeId);
    if (other?.conflicts?.includes(r.id) === true) return true;
  }
  return false;
}

/**
 * Start `forced` (or a fresh weighted selection). Returns the ids that actually went live —
 * anything already running, unknown, or in conflict is skipped.
 */
export function startSpecialRounds(forced?: readonly string[]): string[] {
  const chosen: SpecialRound[] = [];

  if (forced !== undefined) {
    for (const id of forced) {
      const r = ROUNDS.find((x) => x.id === id);
      // Never start a round twice, and never stack one onto a round it conflicts with.
      if (r === undefined || activeRounds.indexOf(r.id) >= 0 || conflicts(r)) continue;
      if (chosen.indexOf(r) >= 0) continue;
      chosen.push(r);
    }
  } else {
    const multiChance = n("sm_ttt_special_multi_chance");
    const provisional = activeRounds.length;
    do {
      const r = pickWeighted();
      if (r === null) break;
      chosen.push(r);
      // Mark it provisionally so the next pick sees it for the conflict/duplicate checks.
      activeRounds.push(r.id);
    } while (multiChance > Math.random());
    // Roll the provisional marks back; `apply` below re-adds them once they really start.
    activeRounds.length = provisional;
  }
  if (chosen.length === 0) return [];

  tellAll(msg("SPECIAL_ROUND_STARTED", chosen.map((r) => r.name).join(", ")));
  for (let i = 0; i < chosen.length; i++) {
    const r = chosen[i]!;
    activeRounds.push(r.id);
    tellAll(msg(r.descKey));
    r.apply();
  }
  sinceSpecial = 0;
  return chosen.map((r) => r.id);
}

/**
 * Turn off every round that is actually running.
 *
 * Only active rounds are cleared: `LowGravRound.clear` restores the gravity it captured in `apply`,
 * so clearing it unconditionally (as a naive sweep over the catalogue would) writes a stale
 * `sv_gravity` over whatever the operator configured.
 */
function clearAll(): void {
  for (let i = 0; i < activeRounds.length; i++) {
    const r = ROUNDS.find((x) => x.id === activeRounds[i]!);
    r?.clear?.();
  }
  activeRounds.length = 0;
}

/**
 * Restore every running special-round cvar (lowgrav, bhop, suppressed pistols).
 *
 * Unload and map change must call this: a hot reload mid-LowGrav used to leave `sv_gravity` scaled
 * because only the Finished listener ran `clearAll`.
 */
export function clearSpecialRounds(): void {
  clearAll();
}

/** Every round id the picker knows about — used by the admin command. */
export function roundIds(): string[] {
  return ROUNDS.map((r) => r.id);
}

/** Register the special-round listeners. */
export function installSpecialRounds(bus: EventBus<TttEvents>): void {
  bus.on("gameState", (ev) => {
    if (ev.state === GameState.Finished) {
      clearAll();
      return;
    }
    if (ev.state !== GameState.InProgress) return;

    sinceSpecial++;
    if (sinceSpecial < n("sm_ttt_special_min_rounds_between")) return;
    if (game.participants < n("sm_ttt_special_min_players")) return;
    if (game.roundsThisMap < n("sm_ttt_special_min_rounds_after_map")) return;
    if (Math.random() > n("sm_ttt_special_chance")) return;
    startSpecialRounds();
  }, { ignoreCanceled: true });

  // Vanilla: refuse every purchase.
  bus.on("purchase", (ev) => {
    if (!isActive("vanilla")) return;
    ev.canceled = true;
    tell(ev.slot, msg("VANILLA_ROUND_REMINDER"));
  }, { priority: Priority.HIGH });

  // Rich: multiply in-round gains.
  bus.on("balance", (ev) => {
    if (!isActive("rich")) return;
    if (ev.reason === RICH_BONUS) return; // never re-multiply our own top-up
    if (ev.newBalance <= ev.oldBalance) return; // gains only
    const gain = ev.newBalance - ev.oldBalance;
    ev.newBalance = ev.oldBalance + Math.trunc(gain * n("sm_ttt_special_rich_gain_multiplier"));
  }, { priority: Priority.LOW });

  // Speed: killing an Innocent buys the Traitors more time.
  bus.on("death", (ev) => {
    speedOnKill(reg.roleOf(ev.slot));
  });

  // Pistol: keep rifles out of players' hands for the whole round.
  bus.on("damage", (ev) => {
    if (!isActive("pistol") || ev.attacker < 0) return;
    if (RIFLES.has(ev.weapon)) ev.canceled = true;
  }, { priority: Priority.HIGHEST });
}

/** Strip any rifle a player has picked up during a Pistol round. Driven by the shared tick. */
export function tickSpecialRounds(): void {
  if (!isActive("pistol")) return;
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    const held = heldWeapons(slot);
    for (let j = 0; j < held.length; j++) {
      const cls = weaponClass(held[j]!);
      if (cls !== "" && RIFLES.has(cls)) {
        clearSlot(slot, GearSlot.Rifle);
        break;
      }
    }
  }
}
