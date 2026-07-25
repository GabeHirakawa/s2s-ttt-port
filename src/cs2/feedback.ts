/**
 * Role feedback and map integration — the port of `ScreenColorApplier` and `MapHookListener`.
 *
 * Two small things the original did on role assignment that are very visible in play:
 *
 *  - a brief screen wash in the role's colour, so you *feel* what you were dealt rather than only
 *    reading it in chat (`ScreenColorApplier`);
 *  - an entity IO context on the pawn (`TRAITOR:1` / `DETECTIVE:1` / `INNOCENT:1`), which is how
 *    TTT-aware maps gate their own logic — traitor-only doors, detective rooms, and so on
 *    (`MapHookListener`). Without it a TTT map silently loses its integrations.
 */

import { Fade } from "@s2script/cs2";
import { GameState, RoleId } from "../core/enums";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf } from "./pawn";
import { ROLE_COLORS } from "./color";

/**
 * Source fade timings are 4.12 fixed point — 1 second is `1 << 12`. The SDK passes the field
 * through untouched ("engine fade units"), so the conversion belongs here.
 */
const FADE_UNITS_PER_SECOND = 1 << 12;

/** `FFADE_OUT` — start opaque and clear, which is the "flash of colour" the original used. */
const FFADE_OUT = 0x0001;
/** `FFADE_PURGE` — drop any fade still running, so back-to-back rounds do not stack washes. */
const FFADE_PURGE = 0x0010;

/** The map context keyword for a role, or "" for roles maps do not gate on. */
function contextFor(role: RoleId): string {
  switch (role) {
    case RoleId.Traitor: return "TRAITOR";
    case RoleId.Detective: return "DETECTIVE";
    case RoleId.Innocent: return "INNOCENT";
    default: return "";
  }
}

/** Every context this plugin sets, for the round-start clear. */
const ALL_CONTEXTS: readonly string[] = ["TRAITOR", "DETECTIVE", "INNOCENT"];

/** Pack RGBA into the fixed32 the fade message expects. */
function packColor(r: number, g: number, b: number, a: number): number {
  // Little-endian RGBA: R in the low byte. `>>> 0` keeps it unsigned.
  return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
}

/** Wash the player's screen in their role's colour. */
function flashRoleColor(slot: number, role: RoleId): void {
  const c = ROLE_COLORS[role];
  if (c === undefined) return;
  Fade.to(slot, {
    duration: 3 * FADE_UNITS_PER_SECOND,
    holdTime: 1 * FADE_UNITS_PER_SECOND,
    // Alpha 64: a tint you read at a glance, not a blind.
    color: packColor(c.r, c.g, c.b, 64),
    flags: FFADE_OUT | FFADE_PURGE,
  });
}

/** Tag the pawn so TTT-aware maps can gate their entity logic on the player's role. */
function applyMapContext(slot: number, role: RoleId): void {
  const keyword = contextFor(role);
  if (keyword === "") return;
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  pawn.ref.acceptInput("AddContext", `${keyword}:1`);
}

/** Strip every role context from a pawn (round start, before roles are dealt again). */
function clearMapContexts(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  for (let i = 0; i < ALL_CONTEXTS.length; i++) {
    pawn.ref.acceptInput("RemoveContext", ALL_CONTEXTS[i]!);
  }
}

/** Register the feedback + map-integration listeners. */
export function installFeedback(bus: EventBus<TttEvents>): void {
  bus.on(
    "roleAssign",
    (ev) => {
      if (ev.canceled || ev.role === RoleId.Spectator) return;
      flashRoleColor(ev.slot, ev.role);
      applyMapContext(ev.slot, ev.role);
    },
    // MONITOR so the context reflects the role karma may have rewritten, not the one first dealt.
    { priority: Priority.MONITOR },
  );

  bus.on(
    "gameState",
    (ev) => {
      // Contexts are cleared when a round ends so the next round starts from a clean pawn — the C#
      // did this on GameInit for the same reason.
      if (ev.state !== GameState.Finished) return;
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) clearMapContexts(active[i]!);
    },
    { ignoreCanceled: true },
  );
}
