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
import { Team } from "../core/enums";

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
export function respawn(slot: number): void {
  Player.fromSlot(slot)?.respawn();
}

/**
 * Drive the controller's `pawnIsAlive` mirror. TTT hides deaths from other clients, so a dead
 * player must keep reading as alive on everyone else's scoreboard until their body is identified —
 * the C# `CS2AliveSpoofer` did this by re-writing the flag every single tick for every spoofed
 * player. Here it is written once on death and once on identification; the engine only resets it
 * on respawn, which TTT controls.
 */
export function setPawnIsAlive(slot: number, value: boolean): void {
  const p = Player.fromSlot(slot);
  if (p !== null) p.pawnIsAlive = value;
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
