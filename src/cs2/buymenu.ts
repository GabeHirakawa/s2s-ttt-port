/**
 * Route the CS2 buy menu into TTT's shop.
 *
 * CS2's buy panel is client-side Panorama: the server cannot open it, close it, or replace it.
 * What the server CAN see is `m_bIsBuyMenuOpen`, which the client replicates up. Polling that for a
 * RISING edge turns the player's existing B key into "open the TTT shop" — no rebind, no typing,
 * and no second thing to learn.
 *
 * The engine's own panel is made inert by `sv_buy_status_override 3` (see `applyServerSettings`),
 * so what sits behind ours lists nothing and buys nothing. TTT still refuses the grant itself at
 * `onCanAcquire`; the cvar is what stops the panel LOOKING live.
 */

import { MAX_SLOTS } from "../core/enums";
import * as reg from "../core/registry";
import { pawnOf } from "./pawn";
import { openShopFor } from "../commands";

/**
 * Poll period. The buy menu stays open orders of magnitude longer than this, so the edge is never
 * missed, and 10 Hz keeps a per-player netvar read off the every-frame path.
 */
const POLL_SECONDS = 0.1;

/** Last observed buy-menu state per slot — 1 = open. The edge, not the level, is what opens the shop. */
const wasOpen = new Uint8Array(MAX_SLOTS);
let accum = 0;

export function tickBuyMenu(dt: number): void {
  accum += dt;
  if (accum < POLL_SECONDS) return;
  accum = 0;

  const slots = reg.activeSlots();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const pawn = pawnOf(slot);
    // No pawn means nothing to read and nothing open. Reading it as CLOSED also clears the edge for
    // a dead, spectating or disconnecting player, so this needs no separate teardown hook — the
    // next time they have a pawn and press B, it is a rising edge again.
    const open = pawn !== null && pawn.isBuyMenuOpen === true;
    if (open && wasOpen[slot] === 0) openShopFor(slot);
    wasOpen[slot] = open ? 1 : 0;
  }
}

/** Drop every remembered edge. Map change and unload, where the pawns are about to go away. */
export function resetBuyMenu(): void {
  wasOpen.fill(0);
  accum = 0;
}
