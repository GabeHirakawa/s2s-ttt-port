/**
 * Game-state commit protocol — validate, write, then observe.
 *
 * `setState` used to emit `gameState` before writing `game.state`. MONITOR meant "later in this
 * dispatch," not "after the transition landed," so every observer (icons, specials, shop, karma)
 * ran against the previous state and would have kept their mutations if a later handler vetoed.
 */

import type { EventBus } from "./bus";
import type { GameState } from "./enums";
import type { TttEvents } from "./events";

/** Holder `setState` mutates. Kept structural so tests do not import `game.ts`. */
export interface StateHolder {
  state: GameState;
}

/**
 * Veto via `gameStateChanging`, commit `holder.state`, then emit post-commit `gameState`.
 * Returns false when a validator canceled; `holder.state` is then unchanged and observers do not run.
 */
export function applyStateTransition(
  bus: EventBus<TttEvents>,
  holder: StateHolder,
  next: GameState,
): boolean {
  const planned = bus.emit("gameStateChanging", { state: next, canceled: false });
  if (planned.canceled) return false;
  holder.state = next;
  bus.emit("gameState", { state: next });
  return true;
}
