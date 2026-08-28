/**
 * TTT's Panorama surfaces: the traitor badge, the shop, and the RDM admin manager.
 *
 * Built entirely on `ctx.ui.components()` — the shared component library — so this plugin ships NO
 * layout of its own. Nothing below names a panel id; it describes rows, titles and handlers, and
 * the library owns paging, selection, per-player state and the reveal animation. That is also what
 * keeps us inside the engine's cap on distinct interned names: the pool is shared with every other
 * plugin rather than minting a private set of ids for TTT.
 *
 * Degrades to nothing for clients without the workshop addon, so chat output stays the floor for
 * every feature here.
 */

import type { PluginContext } from "@s2script/sdk/plugin";
import type { Badge, Components, Modal, Row } from "@s2script/cs2/ui";
import { Player } from "@s2script/cs2";
import { Server } from "@s2script/sdk/server";
import { MAX_SLOTS } from "../core/enums";
import {
  allItems, balanceOf, canPurchase, tryPurchase, resultMessage, PurchaseResult,
} from "../shop/shop";
import type { ShopItem } from "../shop/shop";
import { pending, rule, ago, Verdict } from "../rdm/reports";
import { msgFor } from "../core/msgs";

const RDM_PAGE = 6;
/** Seconds of game time a slot must wait between purchases. */
const BUY_DEBOUNCE = 0.3;

export class TttHud {
  private readonly ui: Components;
  private readonly shop: Modal | null;
  private readonly rdm: Modal | null;
  private readonly badge: Badge | null;
  /** Per-admin slay count, held while the RDM modal is open. */
  private readonly slays = new Map<number, number>();
  /** Last buy per slot, in game time — see {@link buySelected}. */
  private readonly lastBuyAt = new Map<number, number>();

  /** Fired when an admin rules Guilty. Sanctioning lives in the plugin, not the UI. */
  onGuilty: ((steamId: string, name: string, slays: number, admin: string) => void) | null = null;

  constructor(
    ctx: PluginContext,
    private readonly log: (s: string) => void,
    private readonly isAdmin: (slot: number) => boolean,
  ) {
    this.ui = ctx.ui.components();
    this.badge = this.ui.badge({ corner: "tr", accent: "bad" });

    this.shop = this.ui.modal({
      title: "TTT Shop",
      subtitle: (slot) => `${balanceOf(slot)} credits`,
      rows: (slot) => this.shopRows(slot),
      // Clicking a row SELECTS it. Buying is a second, deliberate press.
      //
      // Buying straight from the row click was wrong twice over: a mis-click spent credits with no
      // way to reconsider, and because a single physical click can reach us more than once, one
      // click could buy the same item twice. Select-then-confirm removes both — the row click is
      // idempotent, and only the Buy button spends anything.
      onPick: (slot) => { this.shop?.refresh(slot); },
      detail: (slot, row, cursor) => this.shopDetail(slot, cursor),
      width: "sm",
      buttons: [
        { text: "Buy", variant: "good", onClick: (slot) => this.buySelected(slot) },
        { text: "Close", variant: "ghost", onClick: (slot) => this.closeShop(slot) },
      ],
    });

    this.rdm = this.ui.modal({
      title: "RDM Reports",
      subtitle: () => `${pending().length} pending`,
      pageSize: RDM_PAGE,
      width: "lg",
      rows: () => this.rdmRows(),
      detail: (slot, row, cursor) => this.rdmDetail(slot, cursor),
      buttons: [
        { text: "Close", variant: "ghost", onClick: (slot) => this.closeRdm(slot) },
        { text: "− slay", variant: "ghost", onClick: (slot) => this.stepSlays(slot, -1) },
        { text: "+ slay", variant: "ghost", onClick: (slot) => this.stepSlays(slot, +1) },
        { text: "Not guilty", variant: "good", onClick: (slot) => this.verdict(slot, Verdict.Innocent) },
        { text: "Guilty", variant: "bad", onClick: (slot) => this.verdict(slot, Verdict.Guilty) },
      ],
    });

    if (!this.shop || !this.rdm) this.log("component pool exhausted — some panels unavailable");
    const b = this.ui.budget();
    this.log(`components ready — interned ${b.panelIds} panel id(s), ${b.classNames} class(es), ` +
      `${b.variables} variable(s); cap ${b.cap} each`);
  }

  /**
   * Spawn the layout entity. Console-command only — see `sm_ttt_hud`.
   *
   * Everything below degrades to a no-op until this succeeds, which is why TTT stays playable
   * with chat as the floor and why nothing here is on the critical path of a round.
   */
  ensure(): string | null { return this.ui.ensure(); }

  // ── traitor badge ─────────────────────────────────────────────────────────────────────────────

  showTraitor(slot: number, mates: readonly string[]): void {
    this.badge?.show(slot, {
      title: "TRAITOR",
      text: mates.length ? mates.join(", ") : "you work alone",
    });
  }

  hideTraitor(slot: number): void { this.badge?.hide(slot); }

  // ── shop ──────────────────────────────────────────────────────────────────────────────────────

  isShopOpen(slot: number): boolean { return this.shop?.isOpen(slot) ?? false; }

  /**
   * Open the Panorama shop. Returns false when there is nothing to show, so the caller can fall
   * back to the chat menu rather than leaving the player with no shop at all.
   *
   * Spawning the layout entity happens HERE because every caller is a console command, which is
   * the only dispatch it is safe from — doing it lazily on a draw is what put the entity creation
   * inside a frame. One `!shop` is enough; no separate `sm_ttt_hud` step for players.
   */
  openShop(slot: number): boolean {
    if (!this.shop) return false;
    const why = this.ui.ensure();
    if (why !== null) {
      this.log(`shop HUD unavailable: ${why}`);
      return false;
    }
    // Hide the whole pool for this player FIRST.
    //
    // Pool panels are shared, and per-player state persists on the entity: anything a previous
    // open (or an older build) revealed and never hid stays revealed. Opening the shop must mean
    // "the shop, and nothing else" rather than "the shop, plus whatever was already up" — which
    // is what put a badge top-left and both sheets overlapping in the centre at once.
    this.ui.hideAll(slot);
    this.shop.open(slot);
    // Server-side truth about what we just drew. "Nothing on screen" has two very different
    // causes — we painted nothing, or we painted and the layout did not show it — and only this
    // separates them.
    const rows = this.shopRows(slot);
    const b = this.ui.budget();
    this.log(
      `shop opened for slot ${String(slot)}: ${String(rows.length)} row(s)` +
      (rows.length > 0 ? ` first="${rows[0]!.a} ${rows[0]!.b ?? ""}"` : "") +
      ` | interned ${String(b.panelIds)} id(s) / ${String(b.variables)} var(s) / ${String(b.classNames)} class(es)`,
    );
    return true;
  }

  closeShop(slot: number): void { this.shop?.close(slot); }

  /** Items this player could ever buy. Role-locked ones are omitted rather than greyed. */
  private buyable(slot: number): readonly ShopItem[] {
    return allItems().filter((it) => canPurchase(slot, it) !== PurchaseResult.WrongRole);
  }

  private shopRows(slot: number): Row[] {
    const items = this.buyable(slot);
    // Never hand back an empty list: an empty sheet is indistinguishable from a broken one.
    if (items.length === 0) {
      return [{ a: "No items available right now", b: "", c: "", disabled: true }];
    }
    return items.map((item) => {
      const why = canPurchase(slot, item);
      return {
        a: msgFor(slot, item.nameKey),
        b: `${item.price}c`,
        c: why === PurchaseResult.Success ? (item.limit ? `limit ${item.limit}` : "") : resultMessage(why),
        disabled: why !== PurchaseResult.Success,
      };
    });
  }

  /** Detail lines for the highlighted row, so a selection is legible before it is paid for. */
  private shopDetail(slot: number, cursor: number): string[] {
    const item = this.buyable(slot)[cursor];
    if (!item) return [];
    const why = canPurchase(slot, item);
    return [
      msgFor(slot, item.nameKey),
      `${String(item.price)} credits — you have ${String(balanceOf(slot))}`,
      why === PurchaseResult.Success ? "Press Buy to purchase" : resultMessage(why),
      msgFor(slot, item.descKey),
    ];
  }

  /** Buy whatever row is highlighted. The ONLY path that spends credits. */
  private buySelected(slot: number): void {
    if (!this.shop) return;
    // A single physical click can reach the server more than once, and two purchases from one
    // press is the kind of bug players notice by being out of credits. One buy per press.
    const now = Server.gameTime;
    const last = this.lastBuyAt.get(slot);
    if (last !== undefined && now - last < BUY_DEBOUNCE) return;
    this.lastBuyAt.set(slot, now);
    this.buy(slot, this.shop.cursor(slot));
  }

  private buy(slot: number, index: number): void {
    const item = this.buyable(slot)[index];
    if (!item) return;
    // The row being greyed is cosmetic — the refusal has to happen here, and it has to SAY why.
    const why = canPurchase(slot, item);
    if (why !== PurchaseResult.Success) {
      this.ui.toast(slot, { title: "Cannot buy", message: resultMessage(why), variant: "warn", holdSeconds: 3 });
      return;
    }
    const result = tryPurchase(slot, item);
    const ok = result === PurchaseResult.Success;
    this.ui.toast(slot, {
      title: ok ? "Purchased" : "Failed",
      message: `${msgFor(slot, item.nameKey)} — ${resultMessage(result)}`,
      variant: ok ? "good" : "bad",
      holdSeconds: 4,
    });
    this.shop?.refresh(slot);   // credits and affordability both moved
  }

  // ── RDM manager ───────────────────────────────────────────────────────────────────────────────

  isRdmOpen(slot: number): boolean { return this.rdm?.isOpen(slot) ?? false; }

  openRdm(slot: number): void {
    this.slays.set(slot, 1);
    this.rdm?.open(slot);
  }

  closeRdm(slot: number): void {
    this.slays.delete(slot);
    this.rdm?.close(slot);
  }

  private rdmRows(): Row[] {
    const now = Date.now() / 1000;
    return pending().map((r) => ({
      a: `${r.reporterName} → ${r.accusedName}`,
      b: `round ${r.round}`,
      c: ago(r.filed, now),
    }));
  }

  private rdmDetail(slot: number, cursor: number): string[] {
    const sel = pending()[cursor];
    const n = this.slays.get(slot) ?? 1;
    if (!sel) return ["", "", "", "select a report"];
    return [
      `${sel.reporterName} reported ${sel.accusedName}`,
      `round ${sel.round} · ${ago(sel.filed, Date.now() / 1000)}`,
      `verdict will apply ${n} slay${n === 1 ? "" : "s"}`,
      // Last line is the library's clamped box. Already escaped and length-capped by the report
      // store — a reason is the one string here a player controls.
      sel.reason,
    ];
  }

  private stepSlays(slot: number, delta: number): void {
    if (!this.rdm?.isOpen(slot)) return;
    this.slays.set(slot, Math.max(0, Math.min(10, (this.slays.get(slot) ?? 1) + delta)));
    this.rdm.refresh(slot);
  }

  private verdict(slot: number, v: Verdict): void {
    if (!this.rdm?.isOpen(slot)) return;
    const report = pending()[this.rdm.cursor(slot)];
    if (!report) return;
    const admin = Player.fromSlot(slot)?.playerName ?? `slot ${slot}`;
    const ruled = rule(report.id, v, this.slays.get(slot) ?? 1, admin);
    if (!ruled) return;

    if (v === Verdict.Guilty) {
      this.onGuilty?.(ruled.accusedSteamId, ruled.accusedName, ruled.slays, admin);
    }
    this.ui.toast(slot, {
      title: v === Verdict.Guilty ? "Guilty" : "Not guilty",
      message: v === Verdict.Guilty
        ? `${ruled.accusedName} — ${ruled.slays} slay(s)`
        : ruled.accusedName,
      variant: v === Verdict.Guilty ? "bad" : "good",
      holdSeconds: 4,
    });
    this.log(`rdm #${ruled.id}: ${ruled.reporterName} vs ${ruled.accusedName} -> ` +
      `${v === Verdict.Guilty ? `guilty (${ruled.slays} slays)` : "innocent"} by ${admin}`);
    this.rdm.select(slot, 0);
    this.refreshRdm();
  }

  /** Repaint every admin with the queue open — a new report has to appear without a reopen. */
  refreshRdm(): void { this.rdm?.refresh(); }

  /** Tell every admin a report landed. The toast is the notification; the modal is the workflow. */
  notifyAdmins(title: string, message: string): void {
    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      if (!this.isAdmin(slot) || !Player.fromSlot(slot)) continue;
      this.ui.toast(slot, { title, message, variant: "warn" });
    }
    this.refreshRdm();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  hideAll(slot: number): void { this.ui.hideAll(slot); }

  resetAll(): void {
    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      if (Player.fromSlot(slot)) this.ui.hideAll(slot);
    }
    this.slays.clear();
  }

  forget(slot: number): void {
    this.slays.delete(slot);
    this.lastBuyAt.delete(slot);
    this.shop?.forget(slot);
    this.rdm?.forget(slot);
    this.ui.forget(slot);
  }
}

/**
 * The live instance, set once at load. A module-level handle rather than a parameter threaded
 * through roles.ts / commands.ts, which have nothing else to do with UI. Null before load and after
 * teardown, so callers use `getTttHud()?.` and a HUD-less build simply does nothing.
 */
let instance: TttHud | null = null;
export function setTttHud(h: TttHud | null): void { instance = h; }
export function getTttHud(): TttHud | null { return instance; }
