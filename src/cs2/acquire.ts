/**
 * CanAcquire view used when the published `@s2script/cs2` package has no `ctx.items`.
 * Values match the engine enums in s2script's CS2 items package.
 */
import type { Player } from "@s2script/cs2";

export const AcquireMethod = {
  PickUp: 0,
  Buy: 1,
} as const;
export type AcquireMethod = (typeof AcquireMethod)[keyof typeof AcquireMethod];

export const AcquireResult = {
  Allowed: 0,
  InvalidItem: 1,
  AlreadyOwned: 2,
  AlreadyPurchased: 3,
  AlreadyRedeemed: 4,
  NotAllowedByLimit: 5,
  NotAllowedByTeam: 6,
  NotAllowedByProhibited: 7,
} as const;
export type AcquireResult = (typeof AcquireResult)[keyof typeof AcquireResult];

export interface CanAcquireView {
  readonly player: Player | null;
  readonly defIndex: number;
  method: AcquireMethod;
  result: AcquireResult;
  readonly skipped: boolean;
}
