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

import { nextPreFrame } from "../core/preframe";
import { cfg } from "../core/cvars";
import { GameState, RoleId } from "../core/enums";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf } from "./pawn";
import { ROLE_COLORS } from "./color";

/**
 * MILLISECONDS, not the 4.12 fixed point this used to assume.
 *
 * The SDK passes these fields through untouched ("engine fade units"), so the scale is ours to get
 * right — and `1 << 12` per second was wrong by a factor of four. It turned a nominal 3s fade after
 * a 1s hold into 12288 and 4096, i.e. roughly a TWELVE second fade after a four second hold. The
 * role wash covered most of the opening of every round, which is precisely the window where players
 * need to be reading the map and each other.
 */
const FADE_UNITS_PER_SECOND = 1000;

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
  // Budget split: hold at full tint for a quarter of the time, spend the rest fading out. Tunable
  // live via `sm_ttt_role_flash_seconds` because the right number here is a feel judgement, not a
  // correctness one, and iterating on it through a redeploy is miserable.
  const total = Math.max(0, cfg.roleFlashSeconds) * FADE_UNITS_PER_SECOND;
  if (total <= 0) return;
  const hold = Math.round(total * 0.25);
  Fade.to(slot, {
    duration: total - hold,
    holdTime: hold,
    // Alpha 64: a tint you read at a glance, not a blind.
    color: packColor(c.r, c.g, c.b, 64),
    flags: FFADE_OUT | FFADE_PURGE,
  });
}

/** Strip every role context from a pawn. */
export function clearMapContexts(slot: number): void {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return;
  for (let i = 0; i < ALL_CONTEXTS.length; i++) {
    pawn.ref.acceptInput("RemoveContext", ALL_CONTEXTS[i]!);
  }
}

/**
 * Tag the pawn so TTT-aware maps can gate their entity logic on the player's role.
 *
 * Returns the keyword applied, or "" if there was nothing to apply or no pawn to apply it to — the
 * diagnostic command reports that back, since "did this land?" is the whole question it exists for.
 */
export function applyMapContext(slot: number, role: RoleId): string {
  const keyword = contextFor(role);
  if (keyword === "") return "";
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return "";
  // CLEAR BEFORE ADDING. Contexts are keyed, so `AddContext INNOCENT:1` does not displace a
  // `TRAITOR:1` already standing — the pawn simply holds both, and a map filter testing TRAITOR
  // still waves the player into the traitor room. That happens whenever a role is rewritten on a
  // pawn that already carries one: a karma rewrite mid-deal, or a re-deal. Both inputs queue on the
  // same I/O pump in the order fired, so the removes are serviced before the add.
  clearMapContexts(slot);
  pawn.ref.acceptInput("AddContext", `${keyword}:1`);
  return keyword;
}

/**
 * Apply the role context one frame after the deal, once the pawn has settled.
 *
 * THE PAWN IS NOT STABLE DURING THE DISPATCH. `roles.ts` commits the role, switches team, then fires
 * `roleAssigned` which calls
 * `applyRoleTeam` -> `switchTeam`, and the engine MAY respawn the pawn inside that call (the hazard
 * already documented at `roles.ts:148` and `icons.ts:550`). Our `acceptInput` queues through
 * `AddEntityIOEvent` rather than running synchronously, so a context applied during the dispatch is
 * fired at a pawn the engine is about to replace and is serviced once it is already gone. The
 * context never reaches the live pawn, every `filter_activator_context` on the map rejects the
 * player, and traitor-only doors are dead FOR EVERYONE.
 *
 * The C# does not hit this because its team switch is itself a `PlayerRoleAssignEvent` handler at
 * default priority (`RoleIconsHandler.OnAssigned` -> `SwitchTeam`), so its MONITOR-priority map hook
 * re-reads `player.Pawn.Value` AFTER the switch and lands on the new pawn. This port hoisted the
 * switch out of the dispatch, which silently inverted that order. Deferring restores it.
 *
 * `retries` covers a respawn that has not finished landing by the next frame — the same discipline
 * `applyRoleVisuals` uses for the model swap, which parents entities to the pawn at this same point.
 */
function scheduleMapContext(slot: number, role: RoleId, retries: number): void {
  if (contextFor(role) === "") return;
  nextPreFrame(() => {
    // The role may have been re-dealt (or the player cut) while we waited.
    if (reg.roleOf(slot) !== role) return;
    const pawn = pawnOf(slot);
    if (pawn === null || !pawn.isValid) {
      if (retries > 0) scheduleMapContext(slot, role, retries - 1);
      return;
    }
    applyMapContext(slot, role);
  }, { slot });
}

/** Register the feedback + map-integration listeners. */
export function installFeedback(bus: EventBus<TttEvents>): void {
  bus.on(
    "roleAssigned",
    (ev) => {
      if (ev.role === RoleId.Spectator) return;
      flashRoleColor(ev.slot, ev.role);
      scheduleMapContext(ev.slot, ev.role, 1);
    },
    // MONITOR so the context reflects the role karma may have rewritten, not the one first dealt.
    { priority: Priority.MONITOR },
  );

  bus.on(
    "gameState",
    (ev) => {
      // COUNTDOWN is the authoritative reset, and the one that actually closes the leak.
      //
      // Clearing only at Finished assumed every round ends through `endGame`. A round that ends any
      // other way — a map change, a hot reload, an `endGame` whose transition is vetoed — leaves
      // last round's TRAITOR:1 standing on a pawn the engine may hand back for the next round, and
      // an Innocent then walks into the traitor room because the map's filter still sees the key. It
      // costs nothing to be certain: Countdown is reached before every deal regardless of how the
      // previous round finished, which is exactly why the C# resets on `GameInitEvent` rather than
      // at the end of a round.
      //
      // Finished is kept as well, to close the post-round window: the map is still live during the
      // reveal, and a Traitor should not still be able to open the traitor door after the round they
      // were a Traitor in has been decided.
      if (ev.state !== GameState.Countdown && ev.state !== GameState.Finished) return;
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) clearMapContexts(active[i]!);
    },
    // MONITOR so a transition some other listener goes on to veto cannot strip contexts out from
    // under a round that is in fact still running (`ignoreCanceled` skips this handler when the
    // event is canceled, but only cancelations that landed BEFORE it ran are visible to it).
    { priority: Priority.MONITOR, ignoreCanceled: true },
  );
}
