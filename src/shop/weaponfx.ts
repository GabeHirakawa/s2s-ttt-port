/**
 * Game-event-driven item behaviour — the port of `SilentAWPItem`'s sound hook, `DnaListener`,
 * `PoisonSmokeListener`, `ClusterGrenadeListener` and the C4 item.
 *
 * These are the items whose effect is triggered by an engine event rather than by damage. They live
 * apart from `effects.ts` because they share one `CMsgTEFireBullets` interception between the Silent
 * AWP and the Suppressed special round — the C# hooked user message 452 separately from each, and
 * re-hooked/unhooked per round.
 */

import { UserMessages, type UserMessageView } from "@s2script/sdk/usermessages";
import { HookResult, type HookResultValue } from "@s2script/sdk/events";
import { Server } from "@s2script/sdk/server";
import { Sound } from "@s2script/sdk/sound";
import { MAX_SLOTS, RoleId } from "../core/enums";
import { n, s } from "../core/cvars";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";
import { Priority, type EventBus } from "../core/bus";
import type { TttEvents } from "../core/events";
import { pawnOf, setHealth, tell } from "../cs2/pawn";
import { applyPoison, ownsDnaScanner } from "./effects";
import { inProgress } from "../game/game";

/** Remaining silenced shots per slot (Silent AWP). */
const silentShots = new Int32Array(MAX_SLOTS);
/** Slots holding a live Poison Smoke charge. */
const poisonSmoke = new Uint8Array(MAX_SLOTS);
/** Slots holding a live Cluster Grenade charge. */
const clusterCharge = new Uint8Array(MAX_SLOTS);
/** When each slot last got a DNA reading on a given body — throttles the message. */
const lastDnaRead = new Map<string, number>();

/** Flavour text for a body with no recoverable DNA, as the C# `missingDnaExplanations`. */
const NO_DNA: readonly string[] = [
  "the killer used gloves... for their bullets",
  "the killer was very careful",
  "the killer wiped the weapon clean",
  "the killer retrieved the bullets",
  "the bullets disintegrated on impact",
  "but no DNA was found",
  "but legal litigation caused the DNA to be lost",
  "and confirmed they were dead",
];

/** Grant `count` silenced shots to a slot. */
export function grantSilentShots(slot: number, count: number): void {
  silentShots[slot] = count;
}
/** Arm a Poison Smoke charge. */
export function armPoisonSmoke(slot: number): void {
  poisonSmoke[slot] = 1;
}
/** Arm a Cluster Grenade charge. */
export function armCluster(slot: number): void {
  clusterCharge[slot] = 1;
}
/** Apply the configured C4 fuse length. */
export function applyC4Fuse(): void {
  Server.setCvar("mp_c4timer", String(n("css_ttt_shop_c4_fuse_time")));
}

/** True while the Suppressed special round wants pistol fire silenced. */
let suppressPistols = false;

/** Turn the Suppressed round's pistol silencing on or off. */
export function setSuppressPistols(on: boolean): void {
  suppressPistols = on;
}

/** Pistol item-definition indices, as the C# `WeaponSoundIndex.PISTOLS`. */
const PISTOL_DEFS: ReadonlySet<number> = new Set([1, 2, 3, 30, 32, 36, 4, 61, 63, 64]);

let hooked = false;

/**
 * Install the single fire-sound interception shared by the Silent AWP and the Suppressed round.
 *
 * The shooter is resolved the way the C# did: the message carries the bullet origin, which is the
 * shooter's eye position, so the nearest matching eye position identifies them. It is a hack in both
 * versions — the message simply does not carry a player id — but it is exact in practice because
 * only the firing player is at that coordinate.
 */
export function installFireHook(): void {
  if (hooked) return;
  hooked = true;
  try {
    UserMessages.onPre("CMsgTEFireBullets", (m): HookResultValue | void => {
      const def = m.readInt("weapon_id") ?? m.readInt("item_def_index");

      if (suppressPistols && def !== null && PISTOL_DEFS.has(def)) return HookResult.Handled;

      const shooter = shooterOf(m);
      if (shooter < 0) return;
      if (silentShots[shooter]! <= 0) return;

      // Only silence the Silent AWP's own weapon.
      const awpDef = n("css_ttt_shop_silentawp_index");
      if (def !== null && def !== awpDef) return;

      silentShots[shooter] = silentShots[shooter]! - 1;
      return HookResult.Handled;
    });
  } catch {
    console.warn("[ttt] fire-bullets message unavailable: Silent AWP and Suppressed are inert");
  }
}

/** Resolve the firing player from the message's bullet origin. */
function shooterOf(m: UserMessageView): number {
  const x = m.readFloat("origin.x");
  const y = m.readFloat("origin.y");
  const z = m.readFloat("origin.z");
  if (x === null || y === null || z === null) return -1;

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    // Eye height is ~64u above the body origin; the C# compared against `GetEyePosition()`.
    const dx = o.x - x;
    const dy = o.y - y;
    const dz = o.z + 64 - z;
    if (dx * dx + dy * dy + dz * dz < 4) return slot;
  }
  return -1;
}

/** Reset every per-round charge. */
export function resetWeaponFx(): void {
  silentShots.fill(0);
  poisonSmoke.fill(0);
  clusterCharge.fill(0);
  lastDnaRead.clear();
}

/** Register the event-driven item behaviours. */
export function installWeaponFx(bus: EventBus<TttEvents>): void {
  installFireHook();

  /**
   * The DNA Scanner. Reading a body tells the scanner who the killer was, unless the trace has
   * decayed or the killer wore Gloves. Runs at LOW priority so the ordinary identification
   * announcement lands first, matching the C# handler's priority.
   */
  bus.on(
    "bodyIdentify",
    (ev) => {
      const slot = ev.identifier;
      if (slot < 0 || !ownsDnaScanner(slot)) return;
      const body = ev.body;

      const key = `${slot}.${body.index}`;
      const now = Server.gameTime;
      const last = lastDnaRead.get(key);
      if (last !== undefined && now - last < 15) return;
      lastDnaRead.set(key, now);

      const roleColour = "";
      if (now - body.timeOfDeath > n("css_ttt_shop_dna_decay_time")) {
        tell(slot, msg("SHOP_ITEM_DNA_EXPIRED", roleColour, body.ownerName));
        return;
      }
      if (body.dnaSuppressed || body.killer < 0) {
        const why = NO_DNA[(Math.random() * NO_DNA.length) | 0]!;
        tell(slot, msg("SHOP_ITEM_DNA_SCANNED_OTHER", roleColour, body.ownerName, why));
        return;
      }
      tell(slot, msg("SHOP_ITEM_DNA_SCANNED", roleColour, body.ownerName, body.killerName));
    },
    { priority: Priority.LOW, ignoreCanceled: true },
  );
}

/**
 * A smoke grenade detonated. If the thrower armed Poison Smoke, everyone inside the cloud who is
 * not a Traitor starts taking poison damage.
 */
export function onSmokeDetonate(thrower: number, x: number, y: number, z: number): void {
  if (thrower < 0 || poisonSmoke[thrower] !== 1 || !inProgress()) return;
  poisonSmoke[thrower] = 0;

  const radius = n("css_ttt_shop_poisonsmoke_radius");
  const radiusSq = radius * radius;
  const sound = s("css_ttt_shop_poisonsmoke_poison_sound");

  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    if (!reg.isAlive(slot)) continue;
    if (reg.roleOf(slot) === RoleId.Traitor) continue;
    const pawn = pawnOf(slot);
    if (pawn === null) continue;
    const o = pawn.origin;
    if (o === null) continue;
    const dx = o.x - x;
    const dy = o.y - y;
    const dz = o.z - z;
    if (dx * dx + dy * dy + dz * dz > radiusSq) continue;

    applyPoison(slot);
    if (sound !== "") Sound.emit(sound, { recipients: [slot] });
  }
}

/**
 * An HE grenade detonated. If the thrower armed a Cluster Grenade, deliver the fragment damage as a
 * ring of secondary blasts around the epicentre.
 *
 * The C# spawned `config.GrenadeCount` real projectiles through a CounterStrikeSharp helper
 * (`GrenadeDataHelper.CreateGrenade`) that builds a `CHEGrenadeProjectile` and hands it a thrower
 * handle. s2script has no equivalent entity-construction path for projectiles, so the fragments are
 * applied as damage in the same circular pattern rather than as physical grenades — the same reach
 * and lethality, without the visual of grenades bouncing outwards.
 */
export function onHeDetonate(thrower: number, x: number, y: number, z: number): void {
  if (thrower < 0 || clusterCharge[thrower] !== 1 || !inProgress()) return;
  clusterCharge[thrower] = 0;

  const count = n("css_ttt_shop_clustergrenade_count");
  const spread = n("css_ttt_shop_clustergrenade_throw_force");
  const active = reg.activeSlots();

  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    const fx = x + Math.cos(angle) * spread * 0.5;
    const fy = y + Math.sin(angle) * spread * 0.5;

    for (let j = 0; j < active.length; j++) {
      const slot = active[j]!;
      if (!reg.isAlive(slot)) continue;
      const pawn = pawnOf(slot);
      if (pawn === null) continue;
      const o = pawn.origin;
      if (o === null) continue;
      const dx = o.x - fx;
      const dy = o.y - fy;
      const dz = o.z - z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 250) continue;
      const damage = Math.round(40 * (1 - dist / 250));
      if (damage <= 0) continue;
      setHealth(slot, (pawn.health ?? 0) - damage);
    }
  }
}
