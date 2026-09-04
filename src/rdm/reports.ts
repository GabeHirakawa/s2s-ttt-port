/**
 * RDM reports: a player accuses someone of random deathmatch, an admin rules on it.
 *
 * The store only. Presentation lives in cs2/ttthud.ts and the commands in commands.ts, so this can
 * be reasoned about (and unit-tested) without a HUD or a server attached.
 *
 * TWO THINGS SHAPE THE DESIGN:
 *
 *   1. THE REASON IS ATTACKER-CONTROLLED TEXT. It is typed in chat by one player and rendered on an
 *      admin's screen through Panorama, which interprets markup. It is escaped and length-capped
 *      HERE, at the boundary where it enters the system, rather than trusting every later consumer
 *      to remember.
 *   2. REPORTS OUTLIVE THE ACCUSED'S SESSION. Someone who RDMs and disconnects is exactly who most
 *      deserves a verdict, so a report stores the accused's SteamID and name as text rather than a
 *      slot, and a slot is resolved lazily only when a sanction is applied.
 */

/**
 * Player slots. Declared here rather than imported so this module has NO dependencies at all —
 * which is what lets it be unit-tested directly by the type-stripping runner, without dragging in
 * the engine-facing half of the plugin.
 */
const MAX_SLOTS = 64;

/** Longest reason kept. A chat line cannot exceed this anyway; the cap is defence in depth. */
const MAX_REASON = 240;

/** Reports retained. Oldest is dropped once full — the pending list is a working queue, not a log. */
const MAX_REPORTS = 64;

/**
 * Plain const object, not a `const enum`.
 *
 * Node's type-stripping test runner refuses `const enum` outright, so a store worth unit-testing
 * cannot use one. The union type below gives the same call-site safety.
 */
export const Verdict = {
  Pending: 0,
  Guilty: 1,
  Innocent: 2,
  Dismissed: 3,
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface RdmReport {
  id: number;
  /** Wall-clock seconds when filed, for "2m ago". */
  filed: number;
  round: number;
  reporterSlot: number;
  reporterName: string;
  accusedSlot: number;
  accusedName: string;
  accusedSteamId: string;
  /** Already escaped and capped — safe to hand straight to a dialog variable. */
  reason: string;
  verdict: Verdict;
  /** Slays awarded when ruled Guilty. */
  slays: number;
  /** Admin who ruled, for the audit line. */
  ruledBy: string;
}

/**
 * Escape Panorama markup and collapse whitespace.
 *
 * Panorama renders its text as markup, so an unescaped `<font color=...>` in a reason would let any
 * player restyle — or hide — content on an admin's HUD. Newlines go too: the detail pane is a fixed
 * height, and a reason full of them would push the rest out of view.
 */
export function sanitizeReason(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const escaped = collapsed
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.length > MAX_REASON ? `${escaped.slice(0, MAX_REASON - 1)}…` : escaped;
}

const reports: RdmReport[] = [];
let nextId = 1;
/** Reports filed per slot this round, to blunt spam. */
const filedThisRound: number[] = new Array<number>(MAX_SLOTS).fill(0);
/** Most a player may file per round. */
export const REPORTS_PER_ROUND = 3;

export const FileResult = {
  Ok: 0,
  RateLimited: 1,
  SelfReport: 2,
  Duplicate: 3,
  EmptyReason: 4,
} as const;
export type FileResult = (typeof FileResult)[keyof typeof FileResult];

/** File a report. `reason` is sanitized here; callers pass raw chat text. */
export function file(args: {
  reporterSlot: number; reporterName: string;
  accusedSlot: number; accusedName: string; accusedSteamId: string;
  reason: string; round: number; now: number;
}): { result: FileResult; report?: RdmReport } {
  if (args.reporterSlot === args.accusedSlot) return { result: FileResult.SelfReport };
  const reason = sanitizeReason(args.reason);
  if (reason.length === 0) return { result: FileResult.EmptyReason };
  if (filedThisRound[args.reporterSlot]! >= REPORTS_PER_ROUND) return { result: FileResult.RateLimited };
  // One pending report per (reporter, accused) pair — re-reporting the same person in the same
  // round is almost always a mis-click or frustration, and it would crowd the admin's list.
  const dup = reports.find((r) =>
    r.verdict === Verdict.Pending &&
    r.reporterSlot === args.reporterSlot &&
    r.accusedSteamId === args.accusedSteamId);
  if (dup) return { result: FileResult.Duplicate };

  const report: RdmReport = {
    id: nextId++,
    filed: args.now,
    round: args.round,
    reporterSlot: args.reporterSlot,
    reporterName: args.reporterName,
    accusedSlot: args.accusedSlot,
    accusedName: args.accusedName,
    accusedSteamId: args.accusedSteamId,
    reason,
    verdict: Verdict.Pending,
    slays: 0,
    ruledBy: "",
  };
  reports.push(report);
  if (reports.length > MAX_REPORTS) reports.shift();
  filedThisRound[args.reporterSlot]!++;
  return { result: FileResult.Ok, report };
}

/** Pending reports, oldest first — an admin should work the queue in order. */
export function pending(): readonly RdmReport[] {
  return reports.filter((r) => r.verdict === Verdict.Pending);
}

export function byId(id: number): RdmReport | undefined {
  return reports.find((r) => r.id === id);
}

/** Rule on a report. Returns the report so a caller can act on the sanction. */
export function rule(id: number, verdict: Verdict, slays: number, admin: string): RdmReport | undefined {
  const r = byId(id);
  if (!r || r.verdict !== Verdict.Pending) return undefined;
  r.verdict = verdict;
  r.slays = verdict === Verdict.Guilty ? Math.max(0, slays) : 0;
  r.ruledBy = admin;
  return r;
}

/** Round boundary: clear the per-round rate limit. Reports themselves survive — an admin may still
 *  be working through last round's queue. */
export function newRound(): void {
  filedThisRound.fill(0);
}

/** Map change / unload. */
export function resetReports(): void {
  reports.length = 0;
  filedThisRound.fill(0);
  nextId = 1;
}

/** "2m ago" / "just now". */
export function ago(filed: number, now: number): string {
  const s = Math.max(0, Math.floor(now - filed));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}
