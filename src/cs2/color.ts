/**
 * Entity tint and transparency — the port of `PlayerExtensions.SetColor` and its callers.
 *
 * The C# wrote `m_clrRender` directly. That field is not in the s2script generated schema, so this
 * goes through the entity's own `Color` / `Alpha` inputs instead (`AddEntityIOEvent`, exposed as
 * `EntityRef.acceptInput`) — the same inputs a map would use on a `prop_dynamic`. Source parses the
 * value string per the input's field type, so `Color` takes `"R G B"` and `Alpha` takes `"0".."255"`.
 *
 * What this is used for, all of it player-visible:
 *   - a dead player's pawn is made fully transparent, so nobody sees a corpse-less body standing
 *     around before the ragdoll is found (`BodySpawner.OnDeath`);
 *   - a ragdoll is tinted with its owner's role colour once identified (`BodyPickupListener`);
 *   - Camouflage lowers a Traitor's alpha (`Items/Camouflage`).
 */

import type { EntityRef } from "@s2script/sdk/entity";
import { RoleId } from "../core/enums";
import { pawnOf } from "./pawn";

/** An RGB triple. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Role colours, matching the C# `IRole.Color` values. */
export const ROLE_COLORS: Readonly<Record<number, Rgb>> = {
  [RoleId.Innocent]: { r: 50, g: 205, b: 50 }, // LimeGreen
  [RoleId.Traitor]: { r: 255, g: 0, b: 0 }, // Red
  [RoleId.Detective]: { r: 30, g: 144, b: 255 }, // DodgerBlue
  [RoleId.Spectator]: { r: 128, g: 128, b: 128 }, // Gray
};

/** Plain white, fully opaque — the reset state. */
export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Tint an entity. Returns false if the input could not be fired. */
export function setEntityColor(ref: EntityRef, c: Rgb): boolean {
  return ref.acceptInput("Color", `${c.r | 0} ${c.g | 0} ${c.b | 0}`);
}

/** Set an entity's opacity, 0 (invisible) to 255 (opaque). */
export function setEntityAlpha(ref: EntityRef, alpha: number): boolean {
  const a = alpha < 0 ? 0 : alpha > 255 ? 255 : alpha | 0;
  return ref.acceptInput("Alpha", String(a));
}

/** Tint a player's pawn. */
export function setPawnColor(slot: number, c: Rgb): boolean {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return false;
  return setEntityColor(pawn.ref, c);
}

/** Set a player pawn's opacity. */
export function setPawnAlpha(slot: number, alpha: number): boolean {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return false;
  return setEntityAlpha(pawn.ref, alpha);
}

/**
 * Hide a dead player's pawn entirely.
 *
 * TTT spawns a ragdoll at the moment of death; without this the original pawn is left standing in
 * the world as a second, undiscoverable body, which gives the death away.
 */
export function hidePawn(slot: number): void {
  setPawnAlpha(slot, 0);
}

/** Restore a pawn to opaque white (round start, respawn). */
export function resetPawnColor(slot: number): void {
  setPawnColor(slot, WHITE);
  setPawnAlpha(slot, 255);
}

/** Tint a corpse with the role its owner turned out to be. */
export function colorBody(ref: EntityRef, role: RoleId): void {
  const c = ROLE_COLORS[role];
  if (c !== undefined) setEntityColor(ref, c);
}
