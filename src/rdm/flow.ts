/**
 * The RDM report FLOW: a suspicious kill becomes a question, an answer becomes a report, a report
 * reaches an admin.
 *
 * Engine-facing wiring only. The two stores it drives — `suspect.ts` (is this worth asking about?)
 * and `prompt.ts` (what has this victim been asked?) — are dependency-free and unit tested; this
 * module is the part that needs a server.
 *
 * THE CHAT CAPTURE IS THE DELICATE PART. Step two swallows the victim's next chat line and turns it
 * into the report's reason. Getting that wrong means eating an innocent bystander's message, so the
 * capture is gated on an explicit per-slot state that only a "yes" can set, expires on its own, and
 * returns "not mine" for every other message on the server — see {@link captureSay}.
 */

import { Menu, MenuStyle } from "@s2script/sdk/menu";
import { ChatColors } from "@s2script/cs2";
import { ADMFLAG, Admin } from "@s2script/sdk/admin";
import { RoleId } from "../core/enums";
import * as reg from "../core/registry";
import { steamIdOf } from "../core/registry";
import type { EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { didStrikeFirst } from "../karma/karma";
import { tell } from "../cs2/pawn";
import { msgFor } from "../core/msgs";
import { getTttHud } from "../cs2/ttthud";
import { game } from "../game/game";
import { classifyKill, describeKill, KillClass } from "./suspect";
import {
  acceptOffer, clearPrompt, decline, offer, resetPrompts, Stage, stageOf, subjectOf, sweep,
  takeContext, type Subject,
} from "./prompt";
import { file as fileReport, FileResult, REPORTS_PER_ROUND, type RdmReport } from "./reports";

/** Is this player an admin (the same GENERIC bar every other admin surface here uses)? */
function isAdmin(slot: number): boolean {
  if (slot < 0) return false;
  return Admin.forSlot(slot)?.hasFlags(ADMFLAG.GENERIC) === true;
}

/**
 * Ask the victim whether they were RDM'd.
 *
 * `MenuStyle.Chat` on purpose. The centre/HUD backends draw through the pooled modal sheets, and
 * there are only two of those for the WHOLE server — already spoken for by the shop, the admin RDM
 * manager and the round log. A prompt that silently failed to appear because a sheet was busy would
 * lose the report, so this takes the backend that always renders.
 */
function askVictim(victim: number, subject: Subject): void {
  const m = new Menu(msgFor(victim, "RDM_ASK_TITLE", subject.accusedName));
  m.style = MenuStyle.Chat;
  m.addItem("yes", `${ChatColors.Red}${msgFor(victim, "RDM_ASK_YES")}`);
  m.addItem("no", `${ChatColors.Green}${msgFor(victim, "RDM_ASK_NO")}`);
  m.onSelect((e) => {
    if (e.info === "yes") {
      if (!acceptOffer(e.slot, Date.now() / 1000)) return;   // lapsed while the menu sat open
      tell(e.slot, msgFor(e.slot, "RDM_ASK_CONTEXT", subject.accusedName));
      return;
    }
    decline(e.slot);
    tell(e.slot, msgFor(e.slot, "RDM_ASK_DISMISSED"));
  });
  // A menu the player closes without choosing is NOT a "no": leaving the offer alive lets them
  // still answer with `!rdmyes` before it expires, and the sweep cleans it up either way.
  m.display(victim, 30);
}

/**
 * Decide whether `ev` deserves a prompt, and raise one.
 *
 * Everything here is read at DEATH time — roles and the damage ledger are both about to be reset by
 * the round boundary, and a question asked ten seconds later has to carry its own answer with it.
 */
function considerDeath(victim: number, killer: number): void {
  // Every bail is logged. A prompt that never appears is indistinguishable from a kill that was
  // judged fine, and the difference between those two is the whole feature — so the decision says
  // itself out loud rather than being reconstructed from the outside.
  const why = (reason: string): void => {
    console.log(`[ttt/rdm] no prompt: victim=${victim} killer=${killer} — ${reason}`);
  };
  if (killer < 0 || killer === victim) { why("no killer (world/suicide)"); return; }
  if (!reg.isConnected(victim) || !reg.isConnected(killer)) { why("someone disconnected"); return; }
  const vRole = reg.roleOf(victim);
  const kRole = reg.roleOf(killer);
  if (vRole === RoleId.None || kRole === RoleId.None) { why(`role None (v=${vRole} k=${kRole})`); return; }
  if (vRole === RoleId.Spectator || kRole === RoleId.Spectator) { why("spectator involved"); return; }

  const selfDefence = didStrikeFirst(victim, killer);
  const klass = classifyKill(
    vRole === RoleId.Traitor,
    kRole === RoleId.Traitor,
    selfDefence,
  );
  if (klass === KillClass.Clean) {
    why(`clean (vRole=${vRole} kRole=${kRole} victimStruckFirst=${selfDefence})`);
    return;
  }

  const subject: Subject = {
    accusedSlot: killer,
    accusedName: reg.nameOf(killer),
    accusedSteamId: steamIdOf(killer),
    round: game.roundsThisMap,
    what: describeKill(klass),
  };
  if (!offer(victim, subject, Date.now() / 1000)) { why("offer refused"); return; }
  askVictim(victim, subject);
  console.log(
    `[ttt/rdm] prompted slot ${victim} about ${subject.accusedName} (class ${klass})`,
  );
}

/**
 * Offer the victim's chat line to the flow.
 *
 * Returns true when the message WAS the awaited context and has been consumed — the caller must
 * then suppress it, because a report reason broadcast to the server tells the accused exactly what
 * was said about them and to whom.
 *
 * Returns false for every other message, which is the overwhelmingly common case; the caller lets
 * those through untouched.
 */
export function captureSay(slot: number, raw: string): boolean {
  if (stageOf(slot) !== Stage.AwaitingContext) return false;
  const text = raw.trim();
  // An empty line is not an answer. Left in AwaitingContext deliberately so they can try again.
  if (text === "") return false;
  // An explicit bail-out, so somebody who changed their mind is not stuck mute until the timeout.
  if (text.toLowerCase() === "cancel") {
    decline(slot);
    tell(slot, msgFor(slot, "RDM_ASK_DISMISSED"));
    return true;
  }
  const subject = takeContext(slot);
  if (subject === null) return false;
  submit(slot, subject, text);
  return true;
}

/** File the report and tell everyone who needs to know. */
function submit(reporter: number, subject: Subject, text: string): void {
  const { result, report } = fileReport({
    reporterSlot: reporter,
    reporterName: reg.nameOf(reporter),
    accusedSlot: subject.accusedSlot,
    accusedName: subject.accusedName,
    accusedSteamId: subject.accusedSteamId,
    // The classification rides along with the player's own words: an admin ruling minutes later
    // has no other way to know what the server thought was wrong with the kill.
    reason: `(${subject.what}) ${text}`,
    round: subject.round,
    now: Date.now() / 1000,
  });

  if (result === FileResult.RateLimited) {
    tell(reporter, msgFor(reporter, "RDM_FILE_RATE_LIMITED", REPORTS_PER_ROUND));
    return;
  }
  if (result === FileResult.Duplicate) {
    tell(reporter, msgFor(reporter, "RDM_FILE_DUPLICATE", subject.accusedName));
    return;
  }
  if (result !== FileResult.Ok || !report) {
    tell(reporter, msgFor(reporter, "RDM_FILE_FAILED"));
    return;
  }
  tell(reporter, msgFor(reporter, "RDM_FILE_OK", subject.accusedName));
  notifyAdmins(report);
}

/**
 * Tell every admin a report landed.
 *
 * Chat AND a toast: the toast is what an admin mid-round actually notices, and the chat line is
 * what survives for one who was reading something else at the time.
 */
export function notifyAdmins(report: RdmReport): void {
  const ui = getTttHud();
  const active = reg.activeSlots();
  let told = 0;
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!isAdmin(slot)) continue;
    told++;
    tell(slot, msgFor(slot, "RDM_ADMIN_NEW", report.reporterName, report.accusedName));
  }
  // The HUD owns its own admin sweep (and repaints any queue already open), so the toast goes
  // through it rather than being duplicated here.
  ui?.notifyAdmins("New RDM report", `${report.reporterName} → ${report.accusedName}`);
  console.log(
    `[ttt/rdm] report #${report.id} ${report.reporterName} -> ${report.accusedName} ` +
    `(round ${report.round}); ${told} admin(s) notified`,
  );
}

/** Drop a leaver's pending question — nobody is there to answer it. */
export function forgetPrompt(slot: number): void {
  clearPrompt(slot);
}

export function resetRdmFlow(): void {
  resetPrompts();
}

/**
 * Expire stale prompts. Driven from the same 1 Hz tick the rest of the mode uses rather than a
 * timer per prompt, so a map change cannot leave a callback holding a dead slot.
 */
export function tickRdmFlow(): void {
  const lapsed = sweep(Date.now() / 1000);
  for (let i = 0; i < lapsed.length; i++) {
    const { slot, stage } = lapsed[i]!;
    if (!reg.isConnected(slot)) continue;
    // Only the typing state is worth a word: they were told to write something and nothing came,
    // and silence there reads as the server having lost it.
    if (stage === Stage.AwaitingContext) tell(slot, msgFor(slot, "RDM_ASK_EXPIRED"));
  }
}

/** Subscribe to deaths. Call once, from the load window. */
export function installRdmFlow(bus: EventBus<TttEvents>): void {
  bus.on("death", (ev) => considerDeath(ev.slot, ev.killer), { ignoreCanceled: true });
  bus.on("leave", (ev) => forgetPrompt(ev.slot));
}

/** Re-offer the pending question, for a player who closed the menu (`!rdmyes` / `!rdmno`). */
export function answerPending(slot: number, yes: boolean): boolean {
  if (stageOf(slot) !== Stage.Offered) return false;
  const subject = subjectOf(slot);
  if (!yes || subject === null) {
    decline(slot);
    tell(slot, msgFor(slot, "RDM_ASK_DISMISSED"));
    return true;
  }
  if (!acceptOffer(slot, Date.now() / 1000)) return false;
  tell(slot, msgFor(slot, "RDM_ASK_CONTEXT", subject.accusedName));
  return true;
}
