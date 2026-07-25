/**
 * CS2 team membership as a role-reveal channel — the port of the team handling spread across
 * `RoundTimerListener.revealRoles`, `BodyPickupListener.OnIdentify` and `SpectatorRole`.
 *
 * TTT uses the engine team as a *public* signal, never as a real team:
 *
 * | team | means                                                                    |
 * |------|--------------------------------------------------------------------------|
 * | T    | role unknown to the server at large — Traitors AND un-revealed Innocents  |
 * | CT   | publicly known innocent — the Detective, and anyone whose body was found  |
 *
 * So everyone plays the round on T except the Detective, who is a publicly-known-good role and
 * starts on CT. As Innocents are identified (their corpse found) they move to CT, and at round end
 * every surviving Innocent is revealed the same way. Traitors are never moved — a player on T is
 * either a Traitor or simply not yet found out, which is exactly the ambiguity the mode runs on.
 *
 * `mp_teammates_are_enemies 1` means this costs nothing mechanically: everyone can shoot everyone
 * regardless of team.
 *
 * THE RESPAWN HAZARD: `switchTeam` may respawn the pawn, which would discard a loadout applied
 * before it. Teams are therefore settled during the countdown (everyone to T) and the Detective's
 * single move happens before their loadout is applied — see `applyLoadout` in roles.ts.
 */

import { RoleId, Team } from "../core/enums";
import * as reg from "../core/registry";
import { isPlayingTeam, switchTeam, teamOf } from "../cs2/pawn";

/** The team a role should be displayed on while a round is live. */
export function teamForRole(role: RoleId): Team {
  return role === RoleId.Detective ? Team.CounterTerrorist : Team.Terrorist;
}

/**
 * Put every player on Terrorist ahead of role assignment.
 *
 * Called repeatedly through the countdown, so a player who joins or is revealed mid-countdown still
 * ends up on T before roles are dealt. Idempotent: a player already on T is skipped, which matters
 * because `switchTeam` can respawn the pawn.
 */
export function resetTeamsToT(): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    // Leave genuine spectators alone — they opted out, they are not hiding a role.
    if (!isPlayingTeam(slot)) continue;
    if (teamOf(slot) === Team.Terrorist) continue;
    switchTeam(slot, Team.Terrorist);
  }
}

/**
 * Move `slot` onto the team its role should display on. Returns true if a move actually happened
 * (the caller may need to re-apply anything the resulting respawn would have discarded).
 */
export function applyRoleTeam(slot: number, role: RoleId): boolean {
  if (role === RoleId.None || role === RoleId.Spectator) return false;
  const want = teamForRole(role);
  if (teamOf(slot) === want) return false;
  switchTeam(slot, want);
  return true;
}

/**
 * Publicly reveal `slot` as a non-Traitor by moving them to CT.
 *
 * Used when a corpse is identified and again at round end. A Traitor is never revealed this way —
 * their team stays T so that "on T" keeps meaning "unknown", not "traitor".
 */
export function revealAsInnocent(slot: number): void {
  if (reg.roleOf(slot) === RoleId.Traitor) return;
  if (!isPlayingTeam(slot)) return; // a spectator has nothing to reveal
  if (teamOf(slot) === Team.CounterTerrorist) return;
  switchTeam(slot, Team.CounterTerrorist);
}

/** Reveal every surviving participant's side at round end. */
export function revealAllRoles(): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const role = reg.roleOf(slot);
    if (role === RoleId.None || role === RoleId.Spectator) continue;
    if (role === RoleId.Traitor) continue;
    revealAsInnocent(slot);
  }
}
