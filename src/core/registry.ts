/**
 * Slot-indexed player state — the port of `IPlayerFinder` + `IRoleAssigner` + `CS2Player`.
 *
 * The C# original stored per-player state in `Dictionary<string, T>` keyed by a SteamID *string*,
 * and resolved a `CCSPlayerController` by scanning for a matching SteamID on every property read.
 * Role lookups (`GetRoles(player).Any(r => r is TraitorRole)`) therefore cost a string hash, a
 * dictionary probe, a list allocation and N runtime type tests — on every death, damage tick and
 * win-condition check.
 *
 * Here every per-player field is an entry in a fixed 64-wide typed array indexed by the engine slot.
 * A role check is one array load and an integer compare. Identity that must outlive a slot (karma,
 * persisted across a reconnect) is keyed by SteamID in a single `Map`, looked up only on connect.
 */

import { Player } from "@s2script/cs2";
import { MAX_SLOTS, RoleId, Team } from "./enums";
import { LIFE_ALIVE } from "../cs2/pawn";

/** Per-slot role for the current round. */
const roles = new Uint8Array(MAX_SLOTS);
/** Per-slot role held in the PREVIOUS round — drives role rotation. */
const prevRoles = new Uint8Array(MAX_SLOTS);
/** Per-slot connected flag. */
const connected = new Uint8Array(MAX_SLOTS);
/** Per-slot "participating in the live round" flag (assigned a playing role and not yet cut). */
const participating = new Uint8Array(MAX_SLOTS);
/** Per-slot SteamID64 as a decimal string; "" when the slot is free. Cached at connect. */
const steamIds: string[] = new Array<string>(MAX_SLOTS).fill("");
/** Per-slot display name, refreshed on connect and at round init. */
const names: string[] = new Array<string>(MAX_SLOTS).fill("");

/**
 * The dense list of connected slots. Maintained incrementally on connect/disconnect so that the
 * many "for every player" loops never allocate — the C# equivalents all called
 * `Utilities.GetPlayers()`, which builds a fresh `List<CCSPlayerController>` every time, several
 * times per tick in the timer-driven handlers.
 */
const active: number[] = [];

/** Live alive-count per role, maintained on spawn/death. Makes the win check O(1) instead of O(n). */
const aliveByRole = new Int32Array(8);

/** Every connected slot, in ascending order. DO NOT mutate — it is the live backing array. */
export function activeSlots(): readonly number[] {
  return active;
}

/** Number of connected clients. */
export function playerCount(): number {
  return active.length;
}

/** Mark `slot` connected and cache its identity. Idempotent. */
export function addPlayer(slot: number, steamId: string, name: string): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  steamIds[slot] = steamId;
  names[slot] = name;
  if (connected[slot] === 1) return;
  connected[slot] = 1;
  // Keep `active` sorted with a single insertion — cheaper than a re-sort and keeps iteration
  // order stable (deterministic role assignment for a given RNG sequence).
  let i = active.length;
  while (i > 0 && active[i - 1]! > slot) i--;
  active.splice(i, 0, slot);
}

/** Mark `slot` disconnected and clear its per-round state. */
export function removePlayer(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS || connected[slot] === 0) return;
  connected[slot] = 0;
  setAlive(slot, false);
  roles[slot] = RoleId.None;
  participating[slot] = 0;
  steamIds[slot] = "";
  names[slot] = "";
  const i = active.indexOf(slot);
  if (i >= 0) active.splice(i, 1);
}

/** Is this slot occupied? */
export function isConnected(slot: number): boolean {
  return slot >= 0 && slot < MAX_SLOTS && connected[slot] === 1;
}

/** The role assigned for this round, or {@link RoleId.None}. */
export function roleOf(slot: number): RoleId {
  return (slot >= 0 && slot < MAX_SLOTS ? roles[slot]! : RoleId.None) as RoleId;
}

/** The role held in the previous round — used to rotate roles between rounds. */
export function prevRoleOf(slot: number): RoleId {
  return (slot >= 0 && slot < MAX_SLOTS ? prevRoles[slot]! : RoleId.None) as RoleId;
}

/** Assign this round's role. Does NOT fire events — the assigner owns that. */
export function setRole(slot: number, role: RoleId): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  const wasAlive = alive[slot] === 1;
  if (wasAlive) aliveByRole[roles[slot]!]!--;
  roles[slot] = role;
  if (wasAlive) aliveByRole[role]!++;
}

/** Snapshot this round's roles into the "previous" table and clear the live ones. */
export function rotateRoles(): void {
  prevRoles.set(roles);
  roles.fill(RoleId.None);
  participating.fill(0);
  aliveByRole.fill(0);
}

/** Per-slot alive flag, kept in sync with spawn/death so `alive` never re-reads the pawn. */
const alive = new Uint8Array(MAX_SLOTS);

/** Is this player alive in the current round? */
export function isAlive(slot: number): boolean {
  return slot >= 0 && slot < MAX_SLOTS && alive[slot] === 1;
}

/** Update the cached alive flag, keeping the per-role alive counters correct. */
export function setAlive(slot: number, value: boolean): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  const now = value ? 1 : 0;
  if (alive[slot] === now) return;
  alive[slot] = now;
  aliveByRole[roles[slot]!]! += value ? 1 : -1;
}

/** How many players holding `role` are alive. O(1) — the win check reads this, not a scan. */
export function aliveCount(role: RoleId): number {
  return aliveByRole[role]!;
}

/** Mark a slot as taking part in the live round (they were dealt a playing role). */
export function setParticipating(slot: number, value: boolean): void {
  if (slot >= 0 && slot < MAX_SLOTS) participating[slot] = value ? 1 : 0;
}

/** Is this slot a participant in the live round? */
export function isParticipating(slot: number): boolean {
  return slot >= 0 && slot < MAX_SLOTS && participating[slot] === 1;
}

/** Cached SteamID64 for a slot ("" if free / bot). */
export function steamIdOf(slot: number): string {
  return slot >= 0 && slot < MAX_SLOTS ? steamIds[slot]! : "";
}

/** Cached display name for a slot. */
export function nameOf(slot: number): string {
  return slot >= 0 && slot < MAX_SLOTS ? names[slot]! : "";
}

/** Refresh the cached name from the engine (called at round init, as the C# `NameUpdater` did). */
export function refreshName(slot: number): void {
  const p = Player.fromSlot(slot);
  if (p !== null) names[slot] = p.playerName ?? names[slot]!;
}

/**
 * Re-seed the whole registry from the engine, discarding per-round state. Called in the plugin
 * factory and on map change, because client lifecycle handlers only fire for clients that connect
 * AFTER the plugin goes active.
 */
export function seedFromEngine(): void {
  active.length = 0;
  connected.fill(0);
  for (const p of Player.allConnected()) {
    addPlayer(p.slot, p.steamId, p.playerName ?? "");
    setAlive(p.slot, computeAlive(p.slot));
  }
}

/**
 * Reconcile the roster against the engine, adding anyone missing and dropping anyone gone, without
 * touching the role state of players who were already known.
 *
 * The client lifecycle handlers are NOT sufficient on their own: `onActive` fires when a client
 * becomes fully connected and receiving snapshots, which never happens for a bot (a fake client has
 * no netchannel). On a bot-populated server TTT would otherwise see an empty roster forever and
 * never start a round. This is cheap and idempotent, so it runs at every round boundary as the
 * authoritative source rather than trusting events to have covered everything.
 *
 * @param added - receives the slots newly discovered, so the caller can fire `join` for them
 *   (that event is what seeds karma and other per-player state).
 * @returns true if the roster changed.
 */
export function syncRoster(added?: number[]): boolean {
  let changed = false;
  if (added !== undefined) added.length = 0;

  // Add anyone the engine knows about that we do not.
  const live = Player.allConnected();
  for (let i = 0; i < live.length; i++) {
    const p = live[i]!;
    if (connected[p.slot] === 1) continue;
    addPlayer(p.slot, p.steamId, p.playerName ?? "");
    setAlive(p.slot, computeAlive(p.slot));
    added?.push(p.slot);
    changed = true;
  }

  // Drop anyone we think is here that the engine no longer reports.
  for (let i = active.length - 1; i >= 0; i--) {
    const slot = active[i]!;
    let stillHere = false;
    for (let j = 0; j < live.length; j++) {
      if (live[j]!.slot === slot) {
        stillHere = true;
        break;
      }
    }
    if (!stillHere) {
      removePlayer(slot);
      changed = true;
    }
  }
  return changed;
}

/**
 * Read the engine's real liveness for a slot: on a playing team with a positive-health pawn. This
 * is the only place that touches the pawn for liveness — everything else reads {@link isAlive}.
 */
export function computeAlive(slot: number): boolean {
  const p = Player.fromSlot(slot);
  if (p === null) return false;
  const team = p.teamNum ?? Team.None;
  if (team !== Team.Terrorist && team !== Team.CounterTerrorist) return false;
  const pawn = p.pawn;
  if (pawn === null) return false;
  // BOTH `lifeState` and health. A positive health reading alone is not liveness: a controller that
  // has a pawn but has never SPAWNED carries the default 100 health with `lifeState` still LIFE_DEAD,
  // so a health-only test reported every un-spawned bot as alive. `eligible()` then dealt them roles,
  // and a round went live with most of its participants dead on the floor — Traitors included, which
  // the win check counts and nobody can kill.
  if (pawn.lifeState !== LIFE_ALIVE) return false;
  return (pawn.health ?? 0) > 0;
}

/** Recompute every cached alive flag from the engine (round boundaries, after mass respawns). */
export function resyncAlive(): void {
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    setAlive(slot, computeAlive(slot));
  }
}

/** Clear all state (plugin unload). */
export function resetRegistry(): void {
  roles.fill(0);
  prevRoles.fill(0);
  connected.fill(0);
  participating.fill(0);
  alive.fill(0);
  aliveByRole.fill(0);
  steamIds.fill("");
  names.fill("");
  active.length = 0;
}
