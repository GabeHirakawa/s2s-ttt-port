/**
 * The victim side of an RDM report: "were you RDM'd?" -> "tell us what happened".
 *
 * A two-step state machine per slot, and the store half only — no menu, no chat, no engine — so it
 * unit tests directly. The engine-facing wiring is `rdm/flow.ts`.
 *
 * WHY TWO STEPS. Asking for free text up front would put every player who died into a "type
 * something" state they did not ask for, and most kills in TTT are legitimate. The yes/no gate
 * means the only people ever asked to write are the ones who chose to accuse.
 *
 * EVERYTHING EXPIRES. A prompt that waits forever is a trap: a player who ignored it would have
 * their next unrelated chat line silently eaten as a report reason days later. Both states carry a
 * deadline and the caller sweeps them.
 */

const MAX_SLOTS = 64;

/** Seconds a victim has to answer yes/no before the offer lapses. */
export const OFFER_SECONDS = 45;
/** Seconds to type the context after answering yes. Longer — they are composing a sentence. */
export const CONTEXT_SECONDS = 120;

export const Stage = {
  Idle: 0,
  /** Offered the yes/no question; waiting on an answer. */
  Offered: 1,
  /** Answered yes; their NEXT chat line is the reason. */
  AwaitingContext: 2,
} as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

/** What the victim is being asked about. Held so the report can be filed after the accused leaves. */
export interface Subject {
  accusedSlot: number;
  accusedName: string;
  accusedSteamId: string;
  /** Round the kill happened in — the report records the kill's round, not the answer's. */
  round: number;
  /** {@link describeKill} text, for the prompt and the filed reason's prefix. */
  what: string;
}

interface Slotted extends Subject {
  stage: Stage;
  deadline: number;
}

const state: (Slotted | null)[] = new Array<Slotted | null>(MAX_SLOTS).fill(null);

function inRange(slot: number): boolean {
  return slot >= 0 && slot < MAX_SLOTS;
}

/**
 * Offer the question to `victim`. Replaces any earlier offer for that slot.
 *
 * Replacing rather than queueing is deliberate: dying twice means the newer death is the one they
 * remember, and a backlog of stale questions is how a player ends up answering about a kill from
 * three rounds ago.
 */
export function offer(victim: number, subject: Subject, now: number): boolean {
  if (!inRange(victim) || victim === subject.accusedSlot) return false;
  state[victim] = { ...subject, stage: Stage.Offered, deadline: now + OFFER_SECONDS };
  return true;
}

export function stageOf(slot: number): Stage {
  if (!inRange(slot)) return Stage.Idle;
  return state[slot]?.stage ?? Stage.Idle;
}

export function subjectOf(slot: number): Subject | null {
  if (!inRange(slot)) return null;
  const s = state[slot];
  return s === null ? null : { ...s };
}

/** "Yes, this was RDM" — move to awaiting-context. False when there was no live offer. */
export function acceptOffer(slot: number, now: number): boolean {
  if (!inRange(slot)) return false;
  const s = state[slot];
  if (!s || s.stage !== Stage.Offered) return false;
  s.stage = Stage.AwaitingContext;
  s.deadline = now + CONTEXT_SECONDS;
  return true;
}

/** "No, that was a good kill" — or an explicit cancel while typing. */
export function decline(slot: number): boolean {
  if (!inRange(slot)) return false;
  const had = state[slot] !== null;
  state[slot] = null;
  return had;
}

/**
 * Consume the awaited chat line. Returns the subject to file against, or null when this slot was
 * not waiting — which is the common case and MUST leave the message alone for normal chat.
 */
export function takeContext(slot: number): Subject | null {
  if (!inRange(slot)) return null;
  const s = state[slot];
  if (!s || s.stage !== Stage.AwaitingContext) return null;
  state[slot] = null;
  return { accusedSlot: s.accusedSlot, accusedName: s.accusedName, accusedSteamId: s.accusedSteamId,
           round: s.round, what: s.what };
}

/** Drop everything that has timed out. Returns the slots that lapsed, so they can be told. */
export function sweep(now: number): { slot: number; stage: Stage }[] {
  const out: { slot: number; stage: Stage }[] = [];
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const s = state[slot];
    if (s === null || now < s.deadline) continue;
    out.push({ slot, stage: s.stage });
    state[slot] = null;
  }
  return out;
}

/** A player left, or the map changed. */
export function clearPrompt(slot: number): void {
  if (inRange(slot)) state[slot] = null;
}

export function resetPrompts(): void {
  state.fill(null);
}
