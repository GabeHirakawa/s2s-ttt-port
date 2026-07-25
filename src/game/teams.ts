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
import { bodyOfPlayer } from "../cs2/bodies";
// game.ts imports this module back, but only ever calls into it from a function body — as this one
// does — so the cycle is never exercised at module-evaluation time.
import { inProgress } from "./game";

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
 * Pin a player who is already in the round to the team their role entitles them to — the port of
 * `TeamChangeHandler.onJoinTeam`'s refusal. Returns true if a move was undone.
 *
 * The C# hooked the `jointeam` client command and returned `Handled` for anyone in a live round, so
 * the change never happened at all. s2script has no client-command hook, so this reacts to the
 * resulting `player_team` instead and undoes the move. The right subscription for that is a PRE-hook
 * returning `HookResult.Handled` on a true return from here: the server still processes the
 * change (which is why it still has to be undone), but the "X has joined the Spectators" broadcast
 * that IS the leak never reaches a client. Called from a post-event handler it still converges on
 * the same end state, one announced event later.
 *
 * Left unguarded, `jointeam` is a lie generator under the team model above: T -> CT forges the
 * "publicly confirmed innocent" signal a Traitor can never legitimately earn, CT -> T un-reveals a
 * player whose corpse was found, and a dead player moving to Spectator announces the death the whole
 * round is built on hiding.
 *
 * The exemptions are the C#'s. Outside a live round every change is allowed — that is the first
 * thing `onJoinTeam` tests, and between rounds people legitimately spectate, join, and get pulled
 * back to T by the countdown. A player with no playing role is somebody else's problem (the
 * late-join handler parks them in spectator, and a `Spectator` role means they opted out or were
 * benched, so their team is theirs to pick). And a player whose corpse has already been identified
 * is publicly dead — nothing they do with their team can leak anything that is still a secret. That
 * last exemption is also load-bearing rather than merely faithful: `revealAsInnocent` puts an
 * identified Innocent on CT while their role still says "Innocent", i.e. entitled to T, so without
 * it this guard would undo every body identification the moment the reveal landed.
 *
 * Every gate lives HERE rather than at the call site, so the guard travels with the function: the
 * pre-hook that suppresses the leak sees the raw event and has no state of its own to test against.
 *
 * @param disconnecting - the event's `disconnect` field. A leaving player fires `player_team` for
 *   team None on the way out; there is nobody left to pin and the registry still reports their role
 *   (it is cleared after the `leave` dispatch), so the bounce would fire at a controller the engine
 *   is already tearing down.
 */
/**
 * Would this team change be refused? A PURE test — it moves nobody.
 *
 * Split out so the `player_team` PRE-hook can suppress the broadcast for a change it knows is about
 * to be undone, without performing the undo itself. That matters because the engine has already
 * applied the change by the time anything observes it: without suppression, a dead-but-unfound
 * player typing `jointeam spec` still produces "X has joined the Spectators" for the whole server —
 * and in a mode whose central secret is who is dead, that notification IS the leak. The C# never had
 * it, because it refused the `jointeam` command outright and no change ever happened.
 *
 * The undo stays in the post-event path, so the switch is issued exactly once.
 */
export function wouldRefuseTeam(slot: number, newTeam: Team, disconnecting = false): boolean {
  // `TeamChangeHandler.onJoinTeam`'s own first test: `if (games.ActiveGame is not { State:
  // IN_PROGRESS }) return HookResult.Continue;`. Without it this drags players back onto T during
  // WAITING/COUNTDOWN/FINISHED — and since roles persist until the next `assignRoles`, it would be
  // LAST round's role deciding the team they are pinned to.
  if (!inProgress()) return false;
  // `isConnected` also absorbs slot -1 from an event with no `userid`.
  if (disconnecting || !reg.isConnected(slot)) return false;

  const role = reg.roleOf(slot);
  if (role === RoleId.None || role === RoleId.Spectator) return false;
  if (bodyOfPlayer(slot)?.identified === true) return false;

  return newTeam !== teamForRole(role);
}

export function enforceRoundTeam(slot: number, newTeam: Team, disconnecting = false): boolean {
  if (!wouldRefuseTeam(slot, newTeam, disconnecting)) return false;

  const role = reg.roleOf(slot);
  const want = teamForRole(role);
  // Never issue a switch that is not needed: `switchTeam` may respawn the pawn (see the respawn
  // hazard above), so a bounce racing a second request — or an engine move that already put them
  // back — must not cost a loadout. The one bounce that does happen can only hit a player who just
  // asked the engine for a team change, which had already taken their loadout off them.
  //
  // This is also what makes the pre-hook call site safe to add on top of the post-event one: if the
  // engine turns out to fire `player_team` BEFORE it writes the team, the pre-hook reads the old
  // team, bails here and suppresses nothing, and the post-event call (which by then reads the new
  // one) still bounces. Worst case is today's visible flicker, never a missed bounce or a double.
  if (teamOf(slot) === want) return false;
  // `switchTeam` is the non-lethal move and works on dead controllers, and the engine events it
  // fires internally do not re-dispatch to handlers on that frame — so this cannot bounce itself.
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
