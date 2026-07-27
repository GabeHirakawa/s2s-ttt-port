/**
 * Centre-screen HUD text.
 *
 * CS2 has no usable "hint text" user message. `HintText.to` sends `CUserMessageTextMsg`, whose `param`
 * field is REPEATED — the message builder's scalar `setString` dropped the value, so an empty message
 * went out and `send()` still reported success because delivery had happened. Everything built on it
 * (both compasses, the look-at nameplate) delivered blank text and looked unimplemented.
 *
 * What CS2 does paint centre-screen is a GAME EVENT fired at one client:
 * `show_survival_respawn_status`, whose `loc_token` is rendered as HTML. That is the route the
 * surftimer port uses, and it is the only one verified to display here.
 *
 * IT PAINTS FOR A SINGLE FRAME. Anything using it must re-fire every frame or it never appears, which
 * is why this module owns a slot-indexed buffer and a per-frame drain rather than exposing a
 * fire-and-forget send: callers set what a player should be seeing, and {@link tickHud} keeps it on
 * screen. Two writers cannot both hold the centre of the screen, so a single buffer per slot is also
 * the honest model of the resource.
 */

import { Player } from "@s2script/cs2";
import { Events } from "@s2script/sdk/events";
import { MAX_SLOTS } from "../core/enums";

/** What each slot should currently be seeing; "" = nothing. */
const text: string[] = new Array<string>(MAX_SLOTS).fill("");

/** CS2 font tiers, largest first. There is no `-l`. */
export const HUD_FONT_BIG = "fontSize-m";
export const HUD_FONT_MID = "fontSize-sm";
export const HUD_FONT_SMALL = "fontSize-s";

/** Wrap `body` in a coloured font span at `size`. */
export function hudLine(body: string, color: string, size = HUD_FONT_MID): string {
  return `<font class='${size}' color='${color}'>${body}</font>`;
}

/** Set (or clear, with "") what `slot` sees in the centre of the screen. */
export function setCenterHud(slot: number, html: string): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  text[slot] = html;
}

/** Clear every slot's HUD — round boundary, map change, unload. */
export function resetHud(): void {
  text.fill("");
}

/**
 * Re-fire every non-empty HUD line. Call from the plugin's per-frame handler.
 *
 * A no-op (one comparison per slot) while nobody has HUD text, which is most of a round.
 */
export function tickHud(): void {
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const html = text[slot]!;
    if (html === "") continue;
    const p = Player.fromSlot(slot);
    if (p === null) {
      text[slot] = "";
      continue;
    }
    Events.fireToClient(slot, "show_survival_respawn_status", {
      loc_token: html,
      duration: 1,
      userid: p.userId,
    });
  }
}
