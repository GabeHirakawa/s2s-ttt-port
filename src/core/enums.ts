/**
 * Shared enums + engine constants.
 *
 * Everything here is a `const enum` so call sites compile to integer literals — role checks and
 * state checks are on the hot path (every death, every damage tick) and must not become property
 * loads. The C# original compared role identity with `is TraitorRole` (a runtime type test) and
 * looked roles up through a `Dictionary<string, ICollection<IRole>>` keyed by SteamID string; here a
 * role is a small integer stored in a slot-indexed `Uint8Array`.
 */

/** A TTT role. Stored per-slot as a `Uint8Array` entry, so keep these under 256. */
export const enum RoleId {
  /** Not participating / not yet assigned. */
  None = 0,
  Innocent = 1,
  Traitor = 2,
  Detective = 3,
  /** Sat out this round (karma timeout, or joined as a spectator). */
  Spectator = 4,
}

/** Round lifecycle state — mirrors the C# `TTT.API.Game.State`. */
export const enum GameState {
  /** Waiting for enough players. */
  Waiting = 0,
  /** Countdown running before roles are handed out. */
  Countdown = 1,
  /** Roles assigned, round live. */
  InProgress = 2,
  /** Round decided; waiting for the engine restart. */
  Finished = 3,
}

/** CS2 team indices (`CsTeam`). */
export const enum Team {
  None = 0,
  Spectator = 1,
  Terrorist = 2,
  CounterTerrorist = 3,
}

/** Source 2 `MoveType_t` values used by the body/ragdoll code. */
export const enum MoveType {
  None = 0,
  Walk = 2,
  Fly = 3,
  VPhysics = 5,
  Noclip = 7,
}

/** `IN_*` button bits within the low 32 of `pawn.buttons`. */
export const enum Button {
  Use = 1 << 5,
  Reload = 1 << 13,
}

/** The maximum player slots the engine addresses. Every per-player array is sized to this. */
export const MAX_SLOTS = 64;

