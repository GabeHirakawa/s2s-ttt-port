/**
 * Is this kill worth asking the victim about?
 *
 * The decision table only — no engine, no roles module, no imports at all — so it can be unit
 * tested directly by the type-stripping runner. Callers translate their own `RoleId` into the two
 * booleans below.
 *
 * TTT's whole social game is that a kill is not self-evidently good or bad, so this deliberately
 * decides only whether to ASK. Nothing here punishes anyone: a suspicious kill opens a question to
 * the victim, and a human answers it. That is why the bar is "could reasonably be RDM", not "is
 * RDM" — the false positives cost one dismissable prompt, and the false negatives cost a player
 * their round with no recourse.
 */

export const KillClass = {
  /** Nothing to ask about. */
  Clean: 0,
  /** Innocent killed Innocent, or Traitor killed Traitor. */
  SameSide: 1,
  /** An Innocent killed a Traitor who had never attacked them — right result, no evidence. */
  UnprovokedOnTraitor: 2,
} as const;
export type KillClass = (typeof KillClass)[keyof typeof KillClass];

/**
 * Classify a kill.
 *
 * @param victimIsTraitor  the VICTIM's side.
 * @param killerIsTraitor  the KILLER's side.
 * @param victimStruckFirst did the victim damage the killer BEFORE this exchange? Self-defence is
 *   never RDM, so it clears every case below.
 *
 * A Traitor killing an Innocent is never questioned — that is the job the role exists to do, and
 * the karma table takes the same early return for the same reason.
 */
export function classifyKill(
  victimIsTraitor: boolean,
  killerIsTraitor: boolean,
  victimStruckFirst: boolean,
): KillClass {
  // Self-defence. Whoever opened fire owns the exchange, whatever the roles turned out to be.
  if (victimStruckFirst) return KillClass.Clean;
  // A Traitor killing an Innocent is the mode working as intended.
  if (killerIsTraitor && !victimIsTraitor) return KillClass.Clean;
  if (killerIsTraitor === victimIsTraitor) return KillClass.SameSide;
  // Innocent killed a Traitor unprovoked: correct outcome, but they could not have known — which
  // is exactly the shape of a lucky RDM, and exactly what a victim should be able to dispute.
  return KillClass.UnprovokedOnTraitor;
}

/** A short, human phrase for the prompt and the report — never a verdict, only what was seen. */
export function describeKill(k: KillClass): string {
  switch (k) {
    case KillClass.SameSide: return "they killed a teammate";
    case KillClass.UnprovokedOnTraitor: return "they killed you without being attacked first";
    default: return "";
  }
}
