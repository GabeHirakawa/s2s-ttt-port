/**
 * Role definitions and assignment — the port of `IRole`, `RatioBasedRole` and `RoleAssigner`.
 *
 * The C# assigner looped `do { tryAssignRole(...) } while (assigned)`, and every iteration walked
 * every role, which called `FindPlayerToAssign` → a LINQ `Count` over the candidate set plus a
 * `GetRoles` dictionary lookup *per player per role per iteration*. For N players that is O(N²)
 * string-hashed lookups just to deal out roles.
 *
 * Here the candidate pool is a plain array that shrinks as players are dealt, target counts are
 * computed once up front, and a role check is an integer compare.
 */

import { MAX_SLOTS, RoleId } from "../core/enums";
import { cfg } from "../core/cvars";
import { msg, msgFor } from "../core/msgs";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { setArmor, setHealth, tell, toSpectator } from "../cs2/pawn";
import { give, stripAll } from "../cs2/inventory";
import { applyRoleTeam } from "./teams";
import { nextFrame } from "@s2script/sdk/timers";

/** The display name for a role, resolved through the phrase table. */
export function roleName(role: RoleId): string {
  return roleNameFor(-1, role);
}

/**
 * The role's display name in `slot`'s language.
 *
 * Use this wherever the result is substituted into a per-player message: a translated sentence with
 * an English role name inside it is worse than either alone.
 */
export function roleNameFor(slot: number, role: RoleId): string {
  switch (role) {
    case RoleId.Innocent: return msgFor(slot, "ROLE_INNOCENT");
    case RoleId.Traitor: return msgFor(slot, "ROLE_TRAITOR");
    case RoleId.Detective: return msgFor(slot, "ROLE_DETECTIVE");
    case RoleId.Spectator: return msgFor(slot, "ROLE_SPECTATOR");
    default: return "";
  }
}

/** Traitor count for a lobby of `n` — `ceil((n - 1) / 5)`, the classic TTT ratio. */
export function traitorTarget(n: number): number {
  return Math.ceil((n - 1) / 5);
}

/** Detective count for a lobby of `n` — `ceil(floor(n / 8) / 1.5)`. */
export function detectiveTarget(n: number): number {
  return Math.ceil(Math.floor(n / 8) / 1.5);
}

/**
 * Deal roles to `pool` (slots), firing `roleAssign` for each so listeners (karma timeout) can veto
 * or rewrite the choice. Returns the number of players who ended up participating.
 *
 * Selection prefers players who did NOT hold the role last round, with a 1-in-6 chance of ignoring
 * that preference so a small server never starves — identical to the C# `RatioBasedRole` behaviour.
 */
/**
 * Roles an admin has reserved for the coming round, by slot. `RoleId.None` = no reservation.
 *
 * Spent at the next assignment, not held: a reservation is for ONE round, so it cannot silently make
 * someone permanently a Traitor. A role whose quota is zero that round (a Detective on a server with
 * detectives disabled, say) simply does not come up, and the reservation is spent anyway.
 */
const reserved = new Int8Array(MAX_SLOTS);

/** Reserve `role` for `slot`'s next assignment. `RoleId.None` cancels. */
export function reserveRole(slot: number, role: RoleId): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  reserved[slot] = role;
}

/** What `slot` has reserved, or `RoleId.None`. */
export function reservedRoleOf(slot: number): RoleId {
  return slot >= 0 && slot < MAX_SLOTS ? (reserved[slot]! as RoleId) : RoleId.None;
}

/** Drop every reservation — map change and unload. */
export function clearReservedRoles(): void {
  reserved.fill(RoleId.None);
}

export function assignRoles(bus: EventBus<TttEvents>, pool: number[]): number {
  const n = pool.length;
  if (n === 0) return 0;

  const wantTraitors = Math.max(0, traitorTarget(n));
  const wantDetectives = Math.max(0, detectiveTarget(n));

  // Deal in the original's role order: Traitor and Detective take their quota, the rest are
  // Innocent. `pool` is consumed in place — each pick swaps the chosen slot to the end and pops.
  let participants = 0;
  participants += deal(bus, pool, RoleId.Traitor, wantTraitors);
  participants += deal(bus, pool, RoleId.Detective, wantDetectives);
  participants += deal(bus, pool, RoleId.Innocent, pool.length);
  return participants;
}

/**
 * Hand out up to `count` of `role` from `pool`, removing each picked slot.
 *
 * Counts SUCCESSFUL deals, not attempts. A pick that gets rewritten to Spectator (a karma timeout)
 * or vetoed outright must not consume a unit of quota — otherwise the round can go live with zero
 * Traitors, and `checkEndConditions` then declares an instant Innocent win about a second later.
 * The C# got this right by construction: its `do { … } while (assigned)` loop re-invoked the role
 * until the quota was actually filled, and its candidate filter excluded anyone already dealt.
 */
function deal(bus: EventBus<TttEvents>, pool: number[], role: RoleId, count: number): number {
  let dealt = 0;
  while (dealt < count && pool.length > 0) {
    const pick = choose(pool, role);
    const slot = pool[pick]!;
    // Swap-and-pop: O(1) removal, and iteration order of the remainder does not matter.
    pool[pick] = pool[pool.length - 1]!;
    pool.pop();

    const ev = bus.emit("roleAssign", { slot, role, canceled: false });
    if (ev.canceled) continue;

    reg.setRole(slot, ev.role);
    if (ev.role === RoleId.Spectator) {
      toSpectator(slot);
      continue;
    }
    reg.setParticipating(slot, true);
    // One round only: a reservation is spent whether or not it was what put them here.
    reserved[slot] = RoleId.None;
    // Team first: `switchTeam` may respawn the pawn, which would discard health/armor/weapons
    // written before it. Only the Detective actually moves here (everyone else is already on T
    // from the countdown), so at most one player pays the extra frame.
    if (applyRoleTeam(slot, ev.role)) {
      const target = slot;
      const role = ev.role;
      void nextFrame().then(() => {
        if (reg.roleOf(target) === role) applyLoadout(target, role);
      });
    } else {
      applyLoadout(slot, ev.role);
    }
    dealt++;
  }
  return dealt;
}

/**
 * Pick an index from `pool`, preferring players who did not hold `role` last round. The 1-in-6
 * escape hatch keeps role rotation from deadlocking when everyone is "fresh out".
 */
function choose(pool: number[], role: RoleId): number {
  // A reservation outranks the weighting: an admin who asked for this role gets it.
  //
  // Done HERE rather than by assigning outside the deal loop, so a reserved player goes through the
  // identical path — the roleAssign dispatch that drives icons, uniforms, glow and loadout, and the
  // quota accounting. Reserving Traitor therefore CONSUMES one of the round's Traitor slots rather
  // than adding one, which is what keeps the ratios honest.
  for (let i = 0; i < pool.length; i++) if (reserved[pool[i]!] === role) return i;

  if (Math.random() < 1 / 6) return (Math.random() * pool.length) | 0;

  // Count fresh candidates first so the pick is uniform over them without allocating a sub-array.
  let fresh = 0;
  for (let i = 0; i < pool.length; i++) if (reg.prevRoleOf(pool[i]!) !== role) fresh++;
  if (fresh === 0) return (Math.random() * pool.length) | 0;

  let target = (Math.random() * fresh) | 0;
  for (let i = 0; i < pool.length; i++) {
    if (reg.prevRoleOf(pool[i]!) === role) continue;
    if (target === 0) return i;
    target--;
  }
  return pool.length - 1;
}

/** Apply a role's health, armor and starting weapons, and tell the player what they are. */
export function applyLoadout(slot: number, role: RoleId): void {
  tell(slot, msgFor(slot, "ROLE_ASSIGNED", roleNameFor(slot, role)));

  if (cfg.stripOnAssign) stripAll(slot);

  const hp = cfg.roleHealth[role]!;
  if (hp > 0) setHealth(slot, hp);
  const armor = cfg.roleArmor[role]!;
  if (armor > 0) setArmor(slot, armor);

  const weapons = cfg.roleWeapons[role]!;
  for (let i = 0; i < weapons.length; i++) give(slot, weapons[i]!);
}

/**
 * Tell each Traitor who their team-mates are. Runs once per round; the C# version rebuilt the
 * traitor set with `GetAlive(typeof(TraitorRole))` (a full LINQ scan with a runtime type test per
 * player) and then a second `Where` per traitor to exclude themselves.
 */
export function revealTraitorBuddies(): void {
  const traitors: number[] = [];
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (reg.roleOf(slot) === RoleId.Traitor && reg.isAlive(slot)) traitors.push(slot);
  }

  for (let i = 0; i < traitors.length; i++) {
    const me = traitors[i]!;
    if (traitors.length === 1) {
      tell(me, msgFor(me, "ROLE_REVEAL_TRAITORS_NONE"));
      continue;
    }
    // Formatted per RECIPIENT, not once outside the loop: the header was being rendered in the
    // server's language and sent to everyone, which defeats the point of per-client translation.
    tell(me, msgFor(me, "ROLE_REVEAL_TRAITORS_HEADER"));
    for (let j = 0; j < traitors.length; j++) {
      if (j === i) continue;
      tell(me, msgFor(me, "ROLE_REVEAL_TRAITORS_ENTRY", reg.nameOf(traitors[j]!)));
    }
  }
}
