/**
 * Death and damage — the port of `CombatHandler`, `DamageCanceler` and `BodySpawner`.
 *
 * TTT hides deaths: when a player dies, only the killer (and, if the killer is a Traitor, the other
 * Traitors) see the kill feed entry. Everyone else keeps seeing the victim as alive until their
 * corpse is found. That means:
 *
 *   - `player_death` is suppressed pre-broadcast and re-fired to a chosen recipient set,
 *   - the controller's `pawnIsAlive` mirror is forced back on,
 *   - a ragdoll body is spawned for others to discover.
 *
 * The C# needed two damage paths — a `player_hurt` game event on Windows and a
 * `CBaseEntity::TakeDamage` vfunc hook elsewhere — because only the latter can *modify* damage.
 * s2script exposes a single portable `ctx.entities.onDamage` pre-hook that does both, so there is
 * one path here.
 */

import { HookResult, Player, type HookResultValue } from "@s2script/cs2";
// `fireToClient` lives on the engine-generic Events, not the CS2 typed overlay.
import { Events } from "@s2script/sdk/events";
import type { GameEvent } from "@s2script/sdk/events";
import type { DamageInfo } from "@s2script/sdk/damage";
import { Server } from "@s2script/sdk/server";
import { RoleId } from "../core/enums";
import { msg } from "../core/msgs";
import type { EventBus } from "../core/bus";
import { sharedDamage, type TttEvents } from "../core/events";
import * as reg from "../core/registry";
import { checkEndConditions, inProgress } from "../game/game";
import { roleName } from "../game/roles";
import { logDamage, logDeath } from "../game/logger";
import { spawnBody } from "./bodies";
import { setHealth, tell } from "./pawn";
import { spoofAlive, unspoofAlive } from "./spoof";
import { refreshInvulnerability } from "./handlers";
import { weaponClass, type HeldWeapon } from "./inventory";

/** Maps a pawn entity index back to the slot that owns it — filled lazily per damage event. */
function slotOfPawn(entityIndex: number): number {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const p = Player.fromSlot(slot);
    const pawn = p === null ? null : p.pawn;
    if (pawn !== null && pawn.ref.index === entityIndex) return slot;
  }
  return -1;
}

/**
 * Slot lookup cache for the damage hook, keyed by pawn entity index.
 *
 * `onDamage` fires per bullet; resolving the victim by scanning every connected player would be
 * O(players) per hit. Pawn entity indices are stable for a life, so the mapping is cached and
 * invalidated wholesale on spawn/death/round change.
 */
const pawnToSlot = new Map<number, number>();

/** Diagnostic counters, surfaced by `ttt status`. */
export const damageDiag = {
  hits: 0,
  fallbackHits: 0,
  noVictim: 0,
  unresolvedVictim: 0,
  canceled: 0,
  applied: 0,
};

/** Drop the pawn→slot cache (a pawn index may be recycled after a respawn). */
export function invalidatePawnCache(): void {
  pawnToSlot.clear();
}

function resolveSlot(entityIndex: number): number {
  const hit = pawnToSlot.get(entityIndex);
  if (hit !== undefined) return hit;
  // Cache misses too (-1): most damage inflictors are grenades and world geometry, and re-scanning
  // every connected player for each of those would make the hook O(players) per hit.
  const slot = slotOfPawn(entityIndex);
  pawnToSlot.set(entityIndex, slot);
  return slot;
}

/**
 * Damage pre-hook. Publishes a `damage` event that listeners may cancel (Taser, One-Hit Knife,
 * out-of-round protection) or rescale, then writes the result back onto the live `DamageInfo`.
 *
 * NOTE: `info` is a block-scoped view — nothing here may await, and nothing may retain it. The
 * `damage` payload is the shared singleton for the same reason.
 */
export function onDamage(bus: EventBus<TttEvents>, info: DamageInfo): HookResultValue | void {
  damageDiag.hits++;
  const victimRef = info.victim;
  if (victimRef === null) {
    damageDiag.noVictim++;
    return;
  }
  const victim = resolveSlot(victimRef.index);
  if (victim < 0) {
    damageDiag.unresolvedVictim++;
    return;
  }

  const attackerRef = info.attacker;
  const attacker = attackerRef === null ? -1 : resolveSlot(attackerRef.index);

  const ev = sharedDamage;
  ev.slot = victim;
  ev.attacker = attacker;
  ev.damage = info.damage;
  ev.weapon = attacker < 0 ? "" : activeClassOf(attacker);
  ev.canceled = false;

  bus.emit("damage", ev);

  if (ev.canceled) {
    damageDiag.canceled++;
    info.damage = 0;
    return HookResult.Handled;
  }
  damageDiag.applied++;
  if (ev.damage !== info.damage) info.damage = ev.damage;

  if (inProgress() && attacker >= 0 && attacker !== victim && ev.damage > 0) {
    logDamage(victim, attacker, ev.weapon, Math.round(ev.damage));
  }
}

/** The class of the attacker's deployed weapon, without allocating. */
function activeClassOf(slot: number): string {
  const p = Player.fromSlot(slot);
  const pawn = p === null ? null : p.pawn;
  if (pawn === null) return "";
  return weaponClass(pawn.activeWeapon as HeldWeapon | null);
}

/**
 * `player_death` pre-hook: suppress the public broadcast and re-fire it only to the killer and (if
 * the killer is a Traitor) their fellow Traitors — the C# `CombatHandler.OnPlayerDeath_Pre`.
 */
export function onDeathPre(bus: EventBus<TttEvents>, ev: GameEvent): HookResultValue | void {
  const victim = ev.getPlayerSlot("userid");
  if (victim < 0) return;

  invalidatePawnCache();

  if (!inProgress()) return;

  const killer = ev.getPlayerSlot("attacker");
  const assister = ev.getPlayerSlot("assister");
  const weapon = ev.getString("weapon");
  const headshot = ev.getBool("headshot");

  // Re-fire to the recipients who are allowed to see it, before we suppress the broadcast.
  if (killer >= 0 && killer !== victim) {
    const victimUserId = Player.fromSlot(victim)?.userId ?? -1;
    const killerUserId = Player.fromSlot(killer)?.userId ?? -1;
    const fields = { userid: victimUserId, attacker: killerUserId, weapon, headshot };
    Events.fireToClient(killer, "player_death", fields);

    if (reg.roleOf(killer) === RoleId.Traitor) {
      const active = reg.activeSlots();
      for (let i = 0; i < active.length; i++) {
        const other = active[i]!;
        if (other === killer || other === victim) continue;
        if (reg.roleOf(other) === RoleId.Traitor) {
          Events.fireToClient(other, "player_death", fields);
        }
      }
    }
  }

  handleDeath(bus, victim, killer, assister, weapon, headshot);
  // Suppress the public broadcast: nobody else learns this player died.
  return HookResult.Handled;
}

/** Apply the TTT consequences of a death: body, alive-spoof, events, win check. */
function handleDeath(
  bus: EventBus<TttEvents>,
  victim: number,
  killer: number,
  assister: number,
  weapon: string,
  headshot: boolean,
): void {
  const role = reg.roleOf(victim);
  const body = spawnBody(
    victim,
    reg.nameOf(victim),
    role,
    killer,
    killer >= 0 ? reg.nameOf(killer) : "",
    weapon,
    Server.gameTime,
  );

  reg.setAlive(victim, false);
  // Keep the victim reading as alive on every other client's scoreboard until their body is found.
  spoofAlive(victim);

  if (body !== null) {
    const created = bus.emit("bodyCreate", { body, canceled: false });
    if (created.canceled) body.ref.remove();
  }

  logDeath(victim, killer, weapon);

  if (killer >= 0 && killer !== victim) {
    const killerRole = reg.roleOf(killer);
    if (killerRole !== RoleId.None) {
      tell(victim, msg("ROLE_REVEAL_DEATH", roleName(killerRole)));
    }
  }

  bus.emit("death", { slot: victim, killer, assister, weapon, headshot });
  checkEndConditions();
}

/**
 * `player_hurt` fallback for the damage bus.
 *
 * `ctx.entities.onDamage` is the proper path — it is a PRE-hook, so a listener can cancel or rescale
 * a hit before it lands. On the current runtime that hook only ever receives the synthetic damage
 * self-test, never real bullet damage, which would leave every damage-driven shop item inert.
 *
 * `player_hurt` fires POST-damage, so this reconstructs the same `damage` event from it and repairs
 * the result afterwards: a cancel restores the health that was taken, and a rescale applies the
 * difference. Behaviourally close, with two honest caveats — the victim sees a momentary dip, and a
 * hit that already reduced them to 0 cannot be undone.
 *
 * Self-disabling: if the real hook ever starts delivering, `damageDiag.hits` becomes non-zero and
 * this path stands down so nothing is processed twice.
 */
export function onPlayerHurt(bus: EventBus<TttEvents>, gev: GameEvent): void {
  if (damageDiag.hits > 0) return; // the real pre-hook is live; leave this alone

  const victim = gev.getPlayerSlot("userid");
  if (victim < 0) return;
  const attacker = gev.getPlayerSlot("attacker");
  const dealt = gev.getInt("dmg_health");
  if (dealt <= 0) return;

  const remaining = gev.getInt("health");
  const weapon = gev.getString("weapon");

  const ev = sharedDamage;
  ev.slot = victim;
  ev.attacker = attacker;
  ev.damage = dealt;
  // `player_hurt` reports a bare weapon name ("ak47"); the rest of the plugin matches full classes.
  ev.weapon = weapon === "" ? "" : weapon.startsWith("weapon_") ? weapon : `weapon_${weapon}`;
  ev.canceled = false;

  damageDiag.fallbackHits++;
  bus.emit("damage", ev);

  if (ev.canceled) {
    damageDiag.canceled++;
    // Give back exactly what this hit took.
    setHealth(victim, remaining + dealt);
    return;
  }
  damageDiag.applied++;
  if (ev.damage !== dealt) {
    // Apply the delta a listener asked for (e.g. the One-Shot Revolver raising it to lethal).
    const target = remaining + dealt - ev.damage;
    setHealth(victim, target);
  }
  if (inProgress() && attacker >= 0 && attacker !== victim) {
    logDamage(victim, attacker, ev.weapon, Math.round(ev.damage));
  }
}

/** `player_spawn`: refresh liveness and drop the stale pawn-index cache. */
export function onSpawn(slot: number): void {
  invalidatePawnCache();
  refreshInvulnerability(slot);
  reg.setAlive(slot, reg.computeAlive(slot));
  // A respawn ends any lingering illusion — they really are alive now.
  unspoofAlive(slot);
}
