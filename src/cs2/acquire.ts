/**
 * CanAcquire enums and the slot-only view this plugin reads.
 *
 * `@s2script/cs2@0.13.0` still has no `ctx.items` types. The host on main does; values match
 * that package's engine enums. `player` here is the slot-bearing subset — the host view is a
 * full Player.
 */
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
  readonly player: { readonly slot: number } | null;
  readonly defIndex: number;
  readonly method: number;
  result: number;
  readonly skipped: boolean;
}
