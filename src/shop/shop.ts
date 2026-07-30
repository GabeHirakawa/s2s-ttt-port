/**
 * The shop — the port of `IShop` / `Shop` / `IShopItem` / `BaseItem` / `RoleRestrictedItem`.
 *
 * Every item in the C# build was a DI-registered class that resolved six services in its
 * constructor and re-loaded its config record on every property read. An item here is a plain
 * descriptor object in a flat array: its price is a number, its role gate is an integer compare,
 * and `onPurchase` is a function.
 *
 * Balances and per-round purchase counts are slot-indexed typed arrays rather than
 * `Dictionary<string, int>` / `Dictionary<string, Dictionary<string, int>>` keyed by SteamID string.
 */

import { MAX_SLOTS, RoleId } from "../core/enums";
import { msg, msgFor } from "../core/msgs";
import * as reg from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { tell } from "../cs2/pawn";
import { inProgress } from "../game/game";

/** Why a purchase was refused. */
export const enum PurchaseResult {
  Success = 0,
  InsufficientFunds = 1,
  NotFound = 2,
  NotPurchasable = 3,
  WrongRole = 4,
  Canceled = 5,
  AlreadyOwned = 6,
  UnknownError = 7,
}

/** A human-readable reason for a refusal. */
export function resultMessage(r: PurchaseResult): string {
  switch (r) {
    case PurchaseResult.InsufficientFunds:
      return "You do not have enough funds to complete this purchase";
    case PurchaseResult.NotFound:
      return "The item was not found in the shop";
    case PurchaseResult.NotPurchasable:
      return "You cannot purchase this item at the moment";
    case PurchaseResult.WrongRole:
      return "You do not have the required role to purchase this item";
    case PurchaseResult.Canceled:
      return "The purchase was canceled";
    case PurchaseResult.AlreadyOwned:
      return "You have purchased the maximum amount of this item";
    default:
      return "An unexpected error occurred";
  }
}

/** A purchasable shop item. */
export interface ShopItem {
  /** Stable machine id (used by `!buy <id>` and the purchase log). */
  id: string;
  /** Phrase key for the display name. */
  nameKey: string;
  /** Phrase key for the description. */
  descKey: string;
  /** Price, read at registration and refreshed with the config. */
  price: number;
  /** Role required to buy, or {@link RoleId.None} for "anyone". */
  role: RoleId;
  /** Times one player may buy this per round; 0 = unlimited. */
  limit: number;
  /** Re-read the price (and any other tunables) from the config snapshot. */
  refresh?: () => void;
  /** Extra gate beyond role/price. Return anything but Success to refuse. */
  canPurchase?: (slot: number) => PurchaseResult;
  /** Apply the item's effect. */
  /**
   * Apply the item. Returning `false` means the item could NOT be delivered — a placement that had
   * nowhere to go, say — and {@link tryPurchase} then refunds the price and un-counts the purchase.
   * Returning nothing means success, so an item with no failure mode needs no return at all.
   */
  onPurchase: (slot: number) => void | boolean;
}

const items: ShopItem[] = [];
const byId = new Map<string, ShopItem>();

/** Credits per slot. */
const balances = new Int32Array(MAX_SLOTS);
/** `purchases[slot * itemCount + itemIndex]` — per-round purchase counts. */
let purchases = new Int32Array(0);

let bus: EventBus<TttEvents>;

/** Wire the shop to the bus. Call before registering items. */
export function initShop(eventBus: EventBus<TttEvents>): void {
  bus = eventBus;
}

/** Register an item. Registration order is the stable identity used by the purchase-count table. */
export function register(item: ShopItem): void {
  if (byId.has(item.id)) return;
  item.refresh?.();
  byId.set(item.id, item);
  items.push(item);
  purchases = new Int32Array(MAX_SLOTS * items.length);
}

/** Every registered item. DO NOT mutate. */
export function allItems(): readonly ShopItem[] {
  return items;
}

/** Look an item up by its machine id. */
export function itemById(id: string): ShopItem | undefined {
  return byId.get(id);
}

/** Re-read every item's tunables after a config refresh. */
export function refreshItems(): void {
  for (let i = 0; i < items.length; i++) items[i]!.refresh?.();
}

/** A player's current credit balance. */
export function balanceOf(slot: number): number {
  return balances[slot]!;
}

/**
 * Add (or subtract) credits, firing the `balance` event so listeners can rescale the change (the
 * Rich special round multiplies gains). `print` controls whether the player is told.
 */
export function addBalance(slot: number, amount: number, reason: string, print = true): void {
  if (amount === 0) return;
  const old = balances[slot]!;
  const ev = bus.emit("balance", {
    slot,
    oldBalance: old,
    newBalance: old + amount,
    reason,
    canceled: false,
  });
  if (ev.canceled) return;

  balances[slot] = ev.newBalance;
  if (!print) return;

  const delta = ev.newBalance - old;
  const sign = delta > 0 ? "+" : "";
  tell(
    slot,
    reason === ""
      ? msg("CREDITS_GIVEN", sign, delta)
      : msg("CREDITS_GIVEN_REASON", sign, delta, reason),
  );
}

/** How many times `slot` has bought `item` this round. */
export function purchaseCount(slot: number, item: ShopItem): number {
  const idx = items.indexOf(item);
  return idx < 0 ? 0 : purchases[slot * items.length + idx]!;
}

/** Clear balances and per-round purchase counts. */
export function resetShop(): void {
  balances.fill(0);
  purchases.fill(0);
}

/**
 * Attempt a purchase. Order of checks mirrors the C# `Shop.TryPurchase`: funds, item gate,
 * per-round limit, then the cancelable event, then charge-and-grant.
 */
export function tryPurchase(slot: number, item: ShopItem, tellWhy = true): PurchaseResult {
  const balance = balances[slot]!;
  if (item.price > balance) {
    if (tellWhy)
      tell(slot, msgFor(slot, "SHOP_INSUFFICIENT_BALANCE", msgFor(slot, item.nameKey), item.price, balance));
    return PurchaseResult.InsufficientFunds;
  }

  const gate = canPurchase(slot, item);
  if (gate !== PurchaseResult.Success) {
    if (tellWhy) {
      tell(
        slot,
        gate === PurchaseResult.UnknownError
          ? msg("SHOP_CANNOT_PURCHASE")
          : msg("SHOP_CANNOT_PURCHASE_WITH_REASON", resultMessage(gate)),
      );
    }
    return gate;
  }

  const ev = bus.emit("purchase", { slot, itemId: item.id, canceled: false });
  if (ev.canceled) return PurchaseResult.Canceled;

  addBalance(slot, -item.price, msg(item.nameKey), tellWhy);

  const idx = items.indexOf(item);
  if (idx >= 0) {
    const key = slot * items.length + idx;
    purchases[key] = purchases[key]! + 1;
  }

  // An item that could not be delivered must not be charged for. A placeable gadget can refuse
   // (no surface in reach), and the player was already debited above — so the money and the
  // per-round purchase count both have to come back, or "too far away" quietly costs full price.
  if (item.onPurchase(slot) === false) {
    addBalance(slot, item.price, msgFor(slot, "SHOP_REFUNDED", msgFor(slot, item.nameKey)), tellWhy);
    if (idx >= 0) {
      const key = slot * items.length + idx;
      purchases[key] = Math.max(0, purchases[key]! - 1);
    }
    return PurchaseResult.NotPurchasable;
  }
  return PurchaseResult.Success;
}

/** Evaluate an item's gates for a player, without charging them. */
export function canPurchase(slot: number, item: ShopItem): PurchaseResult {
  if (!inProgress()) return PurchaseResult.NotPurchasable;
  if (item.role !== RoleId.None && reg.roleOf(slot) !== item.role) return PurchaseResult.WrongRole;
  if (item.limit > 0 && purchaseCount(slot, item) >= item.limit) return PurchaseResult.AlreadyOwned;
  const extra = item.canPurchase?.(slot);
  return extra ?? PurchaseResult.Success;
}

/**
 * Items sorted for display: affordable-and-allowed first, then by price, then by name.
 *
 * The C# cached this per player in a dictionary keyed by SteamID and re-sorted with a comparator
 * that called `CanPurchase` (a role-dictionary lookup) up to four times per comparison — O(n log n)
 * dictionary probes per listing. Here each item's sort key is computed once into a parallel array.
 */
export function sortedFor(slot: number, out: ShopItem[]): ShopItem[] {
  out.length = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // Hide items this player's role can never buy, matching the C# list filter.
    //
    // The role test used to be suppressed outside a live round (`&& inProgress()`), which meant the
    // listing showed the WHOLE catalogue — Traitor items included — to everyone during the countdown,
    // before any role had been dealt. Filtering unconditionally means a player with no role yet sees
    // only the role-agnostic items, which is the honest answer to "what can I buy right now".
    if (item.role !== RoleId.None && reg.roleOf(slot) !== item.role) continue;
    out.push(item);
  }

  const affordable = new Map<ShopItem, number>();
  const balance = balances[slot]!;
  for (let i = 0; i < out.length; i++) {
    const item = out[i]!;
    const ok = canPurchase(slot, item) === PurchaseResult.Success && item.price <= balance;
    affordable.set(item, ok ? 0 : 1);
  }

  out.sort((a, b) => {
    const d = affordable.get(a)! - affordable.get(b)!;
    if (d !== 0) return d;
    if (a.price !== b.price) return a.price - b.price;
    return msg(a.nameKey) < msg(b.nameKey) ? -1 : 1;
  });
  return out;
}
