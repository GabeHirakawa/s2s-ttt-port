/**
 * TTT's Panorama surfaces: the traitor badge, the shop, and the RDM admin manager.
 *
 * Built entirely on the shared `hudkit` component library — so this plugin ships NO
 * layout of its own. Nothing below names a panel id; it describes rows, titles and handlers, and
 * the library owns paging, selection, per-player state and the reveal animation. That is also what
 * keeps us inside the engine's cap on distinct interned names: the pool is shared with every other
 * plugin rather than minting a private set of ids for TTT.
 *
 * Degrades to nothing for clients without the workshop addon, so chat output stays the floor for
 * every feature here.
 */

import type { Badge, Components, Modal, ModalSpec, Row } from "@s2script/cs2/ui";
import { CustomHudLayout, hudkit, Player } from "@s2script/cs2";
import { Server } from "@s2script/sdk/server";
import { MAX_SLOTS } from "../core/enums";
import {
  allItems, balanceOf, canPurchase, tryPurchase, resultMessage, PurchaseResult,
} from "../shop/shop";
import type { ShopItem } from "../shop/shop";
import { pending, rule, ago, Verdict } from "../rdm/reports";
import { msg, msgFor } from "../core/msgs";

const RDM_PAGE = 6;
/** Log lines per page. The sheet is `xl`, so it can carry more rows than the shop. */
const LOG_PAGE = 8;
/** Seconds of game time a slot must wait between purchases. */
const BUY_DEBOUNCE = 0.3;

export class TttHud {
  private readonly ui: Components;
  /**
   * Pooled sheets are HOST-GLOBAL and there are only two of them, shared with every other plugin —
   * including the framework's own menu renderer, which is what `sm_admin` paints through. Claiming
   * both at load (which TTT used to do) starved that renderer permanently: `sm_admin` froze the
   * player for a sheet that could never be drawn.
   *
   * So claim on FIRST OPEN rather than at load: a server where nobody opens the shop never spends a
   * sheet, and the framework renderer gets one either way.
   *
   * Deliberately NOT released on close. `Modal.release` frees the pool slot but leaves this
   * layout's button handlers registered, and `HudLayout.onClick` THROWS on a duplicate id — so a
   * release/re-claim cycle re-registers the same row ids and blows up on the second open. Holding
   * the claim once taken is the safe half of the fix.
   */
  private shop: Modal | null = null;
  private rdm: Modal | null = null;
  private logs: Modal | null = null;
  private readonly badge: Badge | null;
  /** Per-admin slay count, held while the RDM modal is open. */
  private readonly slays = new Map<number, number>();
  /** Last buy per slot, in game time — see {@link buySelected}. */
  private readonly lastBuyAt = new Map<number, number>();

  /** Built once in the constructor; handed to {@link Components.modal} on each claim. */
  private readonly shopSpec: ModalSpec;
  private readonly rdmSpec: ModalSpec;
  private readonly logsSpec: ModalSpec;
  /** The round log as rows, rebuilt on each open. */
  private logRows: Row[] = [];

  /** Fired when an admin rules Guilty. Sanctioning lives in the plugin, not the UI. */
  onGuilty: ((steamId: string, name: string, slays: number, admin: string) => void) | null = null;

  constructor(
    private readonly log: (s: string) => void,
    private readonly isAdmin: (slot: number) => boolean,
  ) {
    // The kit MUST come from this plugin's own ctx-bound layout, not from the module-level
    // `hudkit`. They are two different ui instances with separate button-handler tables and
    // separate click subscriptions: `hudkit` resolves through `hostKit()`, which builds its base
    // with a stand-in `reg` and is first resolved during prelude eval — outside the load window,
    // where the click hook cannot subscribe. Panels claimed through it PAINT but never receive a
    // click. Passing the descriptor explicitly bypasses the shared instance and binds this kit to
    // the ctx whose hook is live. Measured: the client sent `s2_m1_r1`, the raw ctx observer saw
    // it, and the modal's own onPick never fired.
    this.ui = CustomHudLayout.components(hudkit.spec);
    this.badge = this.ui.badge({ corner: "tr", accent: "bad" });

    this.shopSpec = {
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
    };

    this.logsSpec = {
      title: "Round Log",
      subtitle: (slot) => `${this.logRows.length} entr${this.logRows.length === 1 ? "y" : "ies"}`,
      pageSize: LOG_PAGE,
      width: "xl",
      rows: () => this.logRows,
      // Rows are plain text: picking one selects it so a long line can be read in the detail box,
      // and nothing else. The log is a record, not a menu.
      onPick: (slot) => { this.logs?.refresh(slot); },
      detail: (slot, row) => (row === undefined ? [] : [row.a]),
      buttons: [{ text: "Close", variant: "ghost", onClick: (slot) => this.closeLogs(slot) }],
    };

    this.rdmSpec = {
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
    };

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
    const why = this.ui.ensure();
    if (why !== null) {
      this.log(`shop HUD unavailable: ${why}`);
      return false;
    }
    const shop = this.claimShop();
    if (shop === null) return false;
    // Hide the whole pool for this player FIRST.
    //
    // Pool panels are shared, and per-player state persists on the entity: anything a previous
    // open (or an older build) revealed and never hid stays revealed. Opening the shop must mean
    // "the shop, and nothing else" rather than "the shop, plus whatever was already up" — which
    // is what put a badge top-left and both sheets overlapping in the centre at once.
    this.ui.hideAll(slot);
    shop.open(slot);
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

  closeShop(slot: number): void {
    this.shop?.close(slot);
  }

  /** Items this player could ever buy. Role-locked ones are omitted rather than greyed. */
  private buyable(slot: number): readonly ShopItem[] {
    return allItems().filter((it) => canPurchase(slot, it) !== PurchaseResult.WrongRole);
  }

  /**
   * Why this player cannot buy this item RIGHT NOW, or Success.
   *
   * `canPurchase` deliberately ignores the balance — funds are checked where the credits actually
   * move, in `tryPurchase`, because a price can only be paid at the moment of paying. For DISPLAY
   * that is one check short: a row you cannot afford has to read as unavailable, or the sheet
   * invites a click whose only possible outcome is a refusal.
   */
  private refusal(slot: number, item: ShopItem): PurchaseResult {
    const why = canPurchase(slot, item);
    if (why !== PurchaseResult.Success) return why;
    return item.price > balanceOf(slot) ? PurchaseResult.InsufficientFunds : PurchaseResult.Success;
  }

  private shopRows(slot: number): Row[] {
    const items = this.buyable(slot);
    // Never hand back an empty list: an empty sheet is indistinguishable from a broken one.
    if (items.length === 0) {
      return [{ a: "No items available right now", b: "", c: "", disabled: true }];
    }
    return items.map((item) => {
      const why = this.refusal(slot, item);
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
    const why = this.refusal(slot, item);
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
    const why = this.refusal(slot, item);
    if (why !== PurchaseResult.Success) {
      this.ui.toast(slot, { title: "Cannot buy", message: resultMessage(why), variant: "warn", holdSeconds: 3 });
      return;
    }
    const result = tryPurchase(slot, item);
    const ok = result === PurchaseResult.Success;
    const name = msgFor(slot, item.nameKey);
    // On success there is no reason to state — say what they bought, and what it does if the item
    // has a description worth reading. Only a refusal gets a reason appended.
    const desc = ok ? msg(item.descKey) : "";
    const detail = desc !== "" && desc !== item.descKey ? desc : "";
    this.ui.toast(slot, {
      title: ok ? "Purchased" : "Failed",
      message: ok
        ? (detail === "" ? name : `${name} — ${detail}`)
        : `${name} — ${resultMessage(result)}`,
      variant: ok ? "good" : "bad",
      holdSeconds: 4,
    });
    this.shop?.refresh(slot);   // credits and affordability both moved
  }

  // ── round log ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Show the round log as a sheet. False when there is no HUD, so the caller can fall back to the
   * console dump that this replaced.
   */
  openLogs(slot: number, lines: readonly string[]): boolean {
    const why = this.ui.ensure();
    if (why !== null) return false;
    const modal = this.claimLogs();
    if (modal === null) return false;
    this.logRows = lines.map((line) => ({ a: line }));
    this.ui.hideAll(slot);
    modal.open(slot);
    modal.select(slot, 0);
    return true;
  }

  isLogsOpen(slot: number): boolean { return this.logs?.isOpen(slot) ?? false; }

  closeLogs(slot: number): void { this.logs?.close(slot); }

  // ── RDM manager ───────────────────────────────────────────────────────────────────────────────

  isRdmOpen(slot: number): boolean { return this.rdm?.isOpen(slot) ?? false; }

  openRdm(slot: number): void {
    const rdm = this.claimRdm();
    if (rdm === null) return;
    this.slays.set(slot, 1);
    rdm.open(slot);
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
    this.logs?.forget(slot);
    this.ui.forget(slot);
    // A player who disconnects with a sheet up is still a viewer as far as the claim is concerned;
    // dropping them here is what lets the last one out release the panel.
  }

  // ── pooled-sheet lifetime ───────────────────────────────────────────────────────────────────
  //
  // Claim on the first viewer, release after the last. `release()` hands the panel back so another
  // plugin can claim it; a claim that fails returns null and every caller already degrades to chat.

  private claimShop(): Modal | null {
    if (this.shop === null) {
      this.shop = this.ui.modal(this.shopSpec);
      if (this.shop === null) this.log("modal pool exhausted — shop falls back to the chat menu");
    }
    return this.shop;
  }

  private claimLogs(): Modal | null {
    if (this.logs === null) {
      this.logs = this.ui.modal(this.logsSpec);
      if (this.logs === null) this.log("modal pool exhausted — round log falls back to console");
    }
    return this.logs;
  }

  private claimRdm(): Modal | null {
    if (this.rdm === null) {
      this.rdm = this.ui.modal(this.rdmSpec);
      if (this.rdm === null) this.log("modal pool exhausted — RDM manager unavailable");
    }
    return this.rdm;
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
