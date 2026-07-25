/**
 * The TTT domain event map — the port of `TTT.Game.Events.*`.
 *
 * Every payload is a plain mutable object addressed by SLOT, not by an `IPlayer` handle. The C#
 * events carried `IPlayer` references whose every property read went back through a SteamID string
 * lookup into a controller cache; a slot is an array index.
 *
 * Payloads are allocated per dispatch (they are mutable and handlers may retain nothing), except
 * where noted — the damage event reuses a singleton because it fires on every bullet.
 */

import type { GameState, RoleId } from "./enums";
import type { Body } from "../cs2/bodies";
import type { Cancelable } from "./bus";

/** A round moved to `state`. Canceling vetoes the transition (the C# `GameStateUpdateEvent`). */
export interface GameStateEvent extends Cancelable {
  state: GameState;
  canceled: boolean;
}

/** A player is about to be given `role`; a handler may rewrite it (karma timeout → Spectator). */
export interface RoleAssignEvent extends Cancelable {
  slot: number;
  role: RoleId;
  canceled: boolean;
}

/** A player died. `killer` is -1 for a suicide/world death. */
export interface DeathEvent {
  slot: number;
  killer: number;
  assister: number;
  weapon: string;
  headshot: boolean;
}

/**
 * A player took damage. SHARED SINGLETON — valid only for the duration of the dispatch; handlers
 * must not retain it. Handlers may lower `damage` or set `canceled` to nullify the hit.
 */
export interface DamageEvent extends Cancelable {
  /** Victim slot. */
  slot: number;
  /** Attacker slot, or -1 (world / unattributed). */
  attacker: number;
  /** Damage that will be applied; writing this modifies the real hit. */
  damage: number;
  /** The inflicting weapon's class name (`weapon_ak47`), or "". */
  weapon: string;
  canceled: boolean;
}

/** A player connected (not necessarily mid-round). */
export interface JoinEvent {
  slot: number;
}

/** A player disconnected. */
export interface LeaveEvent {
  slot: number;
}

/** A corpse was created. Canceling removes the ragdoll immediately. */
export interface BodyCreateEvent extends Cancelable {
  body: Body;
  canceled: boolean;
}

/** Someone walked into a corpse and identified it. `identifier` is a slot. */
export interface BodyIdentifyEvent extends Cancelable {
  body: Body;
  identifier: number;
  canceled: boolean;
}

/** A player's karma changed. Handlers may rewrite `karma` before it is stored. */
export interface KarmaEvent extends Cancelable {
  slot: number;
  oldKarma: number;
  karma: number;
  canceled: boolean;
}

/** A player's credit balance is changing. Handlers may rewrite `newBalance` (Rich round). */
export interface BalanceEvent extends Cancelable {
  slot: number;
  oldBalance: number;
  newBalance: number;
  reason: string;
  canceled: boolean;
}

/** A player is buying `itemId`. Canceling refuses the sale (Vanilla round). */
export interface PurchaseEvent extends Cancelable {
  slot: number;
  itemId: string;
  canceled: boolean;
}

/** A special round was enabled. */
export interface SpecialRoundEvent {
  id: string;
}

/** The complete event map this plugin's bus is typed over. */
export interface TttEvents {
  gameState: GameStateEvent;
  roleAssign: RoleAssignEvent;
  death: DeathEvent;
  damage: DamageEvent;
  join: JoinEvent;
  leave: LeaveEvent;
  bodyCreate: BodyCreateEvent;
  bodyIdentify: BodyIdentifyEvent;
  karma: KarmaEvent;
  balance: BalanceEvent;
  purchase: PurchaseEvent;
  specialRound: SpecialRoundEvent;
}

/**
 * The reused damage payload. `ctx.entities.onDamage` fires for every bullet of every automatic
 * weapon from every player — allocating a fresh object there is the one place in this plugin where
 * GC pressure would actually be measurable, so this one is recycled.
 */
export const sharedDamage: DamageEvent = {
  slot: -1,
  attacker: -1,
  damage: 0,
  weapon: "",
  canceled: false,
};
