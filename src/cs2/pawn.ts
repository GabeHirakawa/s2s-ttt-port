/**
 * Thin CS2 pawn/controller helpers — the port of `CS2Player` + `PlayerExtensions`.
 *
 * `CS2Player` resolved its controller by parsing its own SteamID string and scanning the server for
 * a match on *every* `Health`/`Armor`/`IsAlive` read, with a cache that re-validated each time.
 * Here a slot resolves through `Player.fromSlot`, which is a direct index into the engine's slot
 * table, and nothing is cached across a frame boundary (a cached pawn ref is exactly the footgun
 * the SDK's liveness gating exists to prevent).
 */

import { Player, type Pawn } from "@s2script/cs2";
import { Chat } from "@s2script/sdk/chat";
import { MAX_SLOTS, Team } from "../core/enums";

/** The pawn for `slot`, or null when disconnected/dead/mid-respawn. */
export function pawnOf(slot: number): Pawn | null {
  const p = Player.fromSlot(slot);
  return p === null ? null : p.pawn;
}

/** Current health, or 0 if there is no live pawn. */
export function getHealth(slot: number): number {
  const pawn = pawnOf(slot);
  return pawn === null ? 0 : (pawn.health ?? 0);
}

/**
 * Set health, replicating the change. A value <= 0 kills the pawn via the engine's own suicide
 * path rather than writing a zero (which leaves a live pawn with no death event).
 */
export function setHealth(slot: number, value: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  if (value <= 0) {
    pawn.slay();
    return;
  }
  pawn.health = value;
  if (value > (pawn.maxHealth ?? 100)) pawn.maxHealth = value;
}

/**
 * Pending kill attribution: `pendingKiller[victim]` is the slot to credit with that victim's next
 * death when the engine reports none.
 *
 * `setHealth(slot, <= 0)` above goes through `pawn.slay()`, and the `player_death` it produces names
 * the victim as their own attacker. So a trap, a poison tick or a hurt station scores as a
 * suicide: the corpse records no killer, the DNA Scanner reports "no DNA was found", and karma sees
 * nobody to hold responsible — the entire risk side of those items disappears. The C# sidestepped it
 * by dispatching its own `PlayerDeathEvent().WithKiller(owner)` rather than letting the engine's
 * event stand.
 *
 * The table lives HERE rather than in `cs2/combat.ts` so that `shop/effects.ts` can record an
 * attribution without importing combat.ts, which would close a cycle back through `cs2/handlers.ts`.
 * combat.ts owns the richer table (`markGadgetKill`, which also carries the weapon name and the
 * Poison-Smoke no-corpse flag) and consumes both in its `player_death` pre-hook, preferring the
 * richer one; this is the killer-only fallback for callers that cannot reach it.
 */
const pendingKiller = new Int32Array(MAX_SLOTS).fill(-1);

/** Credit `killer` with `victim`'s next death. Consumed by the death hook. */
export function attributeNextDeath(victim: number, killer: number): void {
  if (victim >= 0 && victim < MAX_SLOTS) pendingKiller[victim] = killer;
}

/** Read-and-clear the pending attribution for `victim` (-1 when there is none). */
export function takeAttributedKiller(victim: number): number {
  if (victim < 0 || victim >= MAX_SLOTS) return -1;
  const killer = pendingKiller[victim]!;
  pendingKiller[victim] = -1;
  return killer;
}

/** Drop every pending attribution (round boundary / respawn). */
export function clearAttributedKills(): void {
  pendingKiller.fill(-1);
}

/** The health every player starts a round on, before their role's own value is applied. */
export const DEFAULT_HEALTH = 100;

/**
 * Put a player back to a clean slate: full health, default max health, no armor.
 *
 * Run through the countdown rather than only at role assignment. Health WAS being set per role at
 * assignment, but three things survived the round boundary that should not have:
 *
 * - **Armor.** `applyLoadout` writes armor only when the role's configured value is above zero, and
 *   every role defaults to zero — so a Kevlar bought last round was never taken back and carried
 *   into the next one for free.
 * - **Max health.** `setHealth` raises `maxHealth` to fit a larger value but never lowers it again,
 *   so a special round that inflated it left every later round starting on the inflated ceiling.
 * - **The countdown itself.** Health was restored at 0:00, which meant players spent the whole
 *   15-second countdown looking at last round's health bar and could not tell whether the mode had
 *   forgotten to heal them. Restoring throughout the countdown makes the reset visible.
 */
export function restoreFullHealth(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  pawn.maxHealth = DEFAULT_HEALTH;
  pawn.health = DEFAULT_HEALTH;
  setArmor(slot, 0);
}

/** Set armor value (and the controller mirror the scoreboard reads). */
export function setArmor(slot: number, value: number): void {
  const pawn = pawnOf(slot);
  if (pawn !== null && pawn.isValid) pawn.armorValue = value;
  const p = Player.fromSlot(slot);
  if (p !== null) p.pawnArmor = value;
}

/** The player's current team. */
export function teamOf(slot: number): Team {
  const p = Player.fromSlot(slot);
  return (p === null ? Team.None : (p.teamNum ?? Team.None)) as Team;
}

/** True when the player is on a team that plays the round. */
export function isPlayingTeam(slot: number): boolean {
  const t = teamOf(slot);
  return t === Team.Terrorist || t === Team.CounterTerrorist;
}

/** Move to spectator (kills the pawn, as the engine's jointeam does). */
export function toSpectator(slot: number): void {
  Player.fromSlot(slot)?.spectate();
}

/**
 * Non-lethal team move — used at round end to put revealed Innocents on CT so the scoreboard and
 * win panel read correctly without killing anyone.
 */
export function switchTeam(slot: number, team: Team): void {
  Player.fromSlot(slot)?.switchTeam(team);
}

/** Respawn a dead player. No-op when they are already alive. */
export function respawn(slot: number): boolean {
  // Returns the SDK's own result rather than discarding it: `Player.respawn` reports false when the
  // player is already alive, the ref is stale, or the Respawn descriptor failed its boot gates —
  // and a silently-dropped false is a player who spends the whole round dead with no clue why.
  return Player.fromSlot(slot)?.respawn() === true;
}

/**
 * Drive the controller's `pawnIsAlive` mirror. TTT hides deaths from other clients, so a dead
 * player must keep reading as alive on everyone else's scoreboard until their body is identified —
 * the C# `CS2AliveSpoofer` did this by re-writing the flag every single tick for every spoofed
 * player. Here it is written once on death and once on identification; the engine only resets it
 * on respawn, which TTT controls.
 */
/**
 * Hold the controller's mirrored health, so the periodic mirror does not read a dead player back.
 *
 * `m_iPawnHealth` and `m_bPawnIsAlive` are both controller-side copies of pawn state, refreshed
 * together by the same think. Spoofing only the alive flag meant the mirror overwrote it roughly
 * eleven times a second for the first second after a death — measured, not guessed — and the client
 * saw a one-frame blip each time.
 */
/**
 * `LIFE_ALIVE`. The pawn's own liveness, which `IsAlive()` reads.
 *
 * Spoofing the CONTROLLER's mirrored flag loses: it is re-derived from the pawn roughly eleven times
 * a second for the first second after a death (measured — a 0 every 6th frame for ~70 frames), and
 * correcting it a frame later is what the scoreboard flicker actually is. Writing the pawn's own
 * state instead means the mirror derives "alive" by itself and there is nothing to fight.
 */
export const LIFE_ALIVE = 0;
/** `LIFE_DEAD` — what the engine sets on a real death, and what the illusion has to put back. */
const LIFE_DEAD = 2;

/** Present a dead pawn as alive to anything that derives from `lifeState` — notably the controller. */
export function setPawnLifeStateAlive(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  if (pawn.lifeState === LIFE_ALIVE) return;
  pawn.lifeState = LIFE_ALIVE;
}

/**
 * Put a spoofed pawn's liveness back to DEAD.
 *
 * The counterpart to `setPawnLifeStateAlive`, and it is not optional: lifting the illusion by
 * clearing only the controller's `m_bPawnIsAlive` leaves the PAWN reading alive, and the controller
 * re-derives from the pawn within a few frames and flips straight back. That is what made an
 * identified body's owner keep showing as alive on the scoreboard.
 */
export function setPawnLifeStateDead(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  if (pawn.lifeState === LIFE_DEAD) return;
  pawn.lifeState = LIFE_DEAD;
}

export function setPawnHealth(slot: number, value: number): void {
  const p = Player.fromSlot(slot);
  if (p === null) return;
  if (p.pawnHealth === value) return;
  p.pawnHealth = value;
}

export function setPawnIsAlive(slot: number, value: boolean): void {
  const p = Player.fromSlot(slot);
  if (p === null) return;
  // Read first, and write ONLY on a difference.
  //
  // The generated setter calls notifyStateChanged on every write, so re-asserting the same value
  // from the per-frame spoof ticker raised the replication flag ~64x a second for every hidden
  // corpse — telling every client the field had changed when it had not. The illusion only needs a
  // write when the ENGINE has flipped it back, which is exactly what this comparison detects.
  if (p.pawnIsAlive === value) return;
  p.pawnIsAlive = value;
}

/**
 * Toggle whether this pawn can be hurt at all (`CBaseEntity::m_bTakesDamage`).
 *
 * This is how TTT enforces "no combat outside a live round". The `OutOfRoundCanceler` port cancels
 * damage through the damage hook, but that hook does not receive real bullet damage on the current
 * runtime — flipping invulnerability on the pawn is enforced by the engine itself and needs no hook.
 */
export function setTakesDamage(slot: number, value: boolean): void {
  const pawn = pawnOf(slot);
  if (pawn !== null && pawn.isValid) pawn.takesDamage = value;
}

/** Mirror a value onto the scoreboard score column (used to surface karma). */
export function setScore(slot: number, value: number): void {
  const p = Player.fromSlot(slot);
  if (p !== null) p.score = value;
}

/** Send a chat line to one slot. */
export function tell(slot: number, message: string): void {
  Chat.toSlot(slot, message);
}

/** Send a chat line to every player. */
export function tellAll(message: string): void {
  Chat.toAll(message);
}
