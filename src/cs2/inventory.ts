/**
 * Weapon give/remove — the port of `CS2InventoryManager` and `Tag`.
 *
 * The C# version returned a `Task` from every operation and marshalled each onto the next world
 * update even when already on the main thread; the s2script event/command handlers already run on
 * the game thread, so these are plain synchronous calls.
 *
 * The weapon-class tag sets are built once into `Set`s (O(1) lookups). The original rebuilt several
 * of them with `.Union(...).ToHashSet()` in static initializers, which is fine, but then queried
 * them from per-tick handlers via LINQ `Contains` over `IReadOnlySet<string>` — same idea, kept.
 */

import { CsItem } from "@s2script/cs2";
import type { Weapon } from "@s2script/cs2";
import { pawnOf } from "./pawn";

/**
 * A held weapon. Alias of the SDK's `Weapon`, kept as a name the rest of the port already uses.
 *
 * This was a hand-written local interface because `@s2script/cs2` re-exported `Weapon` from a module
 * its `files` list did not ship, so the published type resolved to `any`. Fixed upstream; the shim is
 * gone and every field is checked again.
 */
export type HeldWeapon = Weapon;

/** Which property carries the weapon's class name on this SDK build; resolved on first use. */
let classKey: string | null = null;

/**
 * The weapon's entity class (`weapon_ak47`), or "" if it cannot be read.
 *
 * ON THIS RUNTIME IT IS ALWAYS "". An entity's class is `CEntityIdentity::m_designerName`, typed
 * `CUtlSymbolLarge` — a string behind a pointer, which the schema codegen skips, and no SDK surface
 * exposes it either (`Entity.findByClass` matches BY a class name but nothing reads one back). The
 * probe below is kept because it costs one property load and would start working the moment a build
 * exposes either name, but it is not expected to find anything today.
 *
 * WHAT THAT COSTS, so the degradation is not silent: every caller comparing a held weapon against a
 * class — knife detection for backstabs, gear-slot classification, "does this player have X",
 * shop item removal, special-round weapon rules — takes the no-match branch. Kill attribution is
 * unaffected: `player_death` carries the weapon name as an event string, which is read directly.
 *
 * The fix belongs upstream: a `designerName` getter on `EntityRef`. The host can read the symbol;
 * only the JS surface is missing.
 */
export function weaponClass(w: HeldWeapon | null | undefined): string {
  if (w === null || w === undefined) return "";
  if (classKey === null) {
    // Structural probe: neither name is on the typed surface, so this looks past it deliberately.
    const probe = w as unknown as Record<string, unknown>;
    classKey =
      typeof probe["className"] === "string" ? "className"
      : typeof probe["designerName"] === "string" ? "designerName"
      : "";
    if (classKey === "") {
      console.log(
        "[ttt] WARN: a weapon's class name cannot be read on this runtime — knife/gear-slot/" +
          "has-weapon/shop-removal checks will not match. Needs an EntityRef designerName getter.",
      );
    }
  }
  if (classKey === "") return "";
  return ((w as unknown as Record<string, unknown>)[classKey] as string | undefined) ?? "";
}

/** Weapons that can backstab. */
export const KNIVES: ReadonlySet<string> = new Set([
  "weapon_knife", "weapon_knife_bayonet", "weapon_knife_butterfly", "weapon_knife_canis",
  "weapon_knife_cord", "weapon_knife_css", "weapon_knife_falchion", "weapon_knife_flip",
  "weapon_knife_gut", "weapon_knife_gypsy_jackknife", "weapon_knife_karambit",
  "weapon_knife_m9_bayonet", "weapon_knife_push", "weapon_knife_skeleton",
  "weapon_knife_stiletto", "weapon_knife_survival_bowie", "weapon_knife_tactical",
  "weapon_knife_talon", "weapon_knife_ursus", "weapon_knife_t", "weapon_bayonet",
]);

/** Thrown items occupying the grenade slot. */
export const GRENADES: ReadonlySet<string> = new Set([
  "weapon_decoy", "weapon_firebomb", "weapon_flashbang", "weapon_hegrenade",
  "weapon_incgrenade", "weapon_molotov", "weapon_smokegrenade", "weapon_tagrenade", "weapon_frag",
]);

/** Pistols — the Suppressed and Pistol special rounds key off this. */
export const PISTOLS: ReadonlySet<string> = new Set([
  "weapon_deagle", "weapon_elite", "weapon_fiveseven", "weapon_glock", "weapon_hkp2000",
  "weapon_p250", "weapon_usp_silencer", "weapon_tec9", "weapon_cz75a", "weapon_revolver",
]);

const SNIPERS = ["weapon_awp", "weapon_ssg08", "weapon_scar20", "weapon_g3sg1"];
const SHOTGUNS = ["weapon_mag7", "weapon_nova", "weapon_sawedoff", "weapon_xm1014"];
const SMGS = [
  "weapon_bizon", "weapon_mac10", "weapon_mp5sd", "weapon_mp7", "weapon_mp9",
  "weapon_p90", "weapon_ump45",
];
const HEAVY = ["weapon_negev", "weapon_m249"];
const ASSAULT = [
  "weapon_ak47", "weapon_aug", "weapon_famas", "weapon_galilar", "weapon_m4a1",
  "weapon_m4a1_silencer", "weapon_sg556",
];

/** Everything that is not a pistol, knife or utility — what the Pistol round strips. */
export const RIFLES: ReadonlySet<string> = new Set([
  ...ASSAULT, ...SNIPERS, ...SHOTGUNS, ...SMGS, ...HEAVY,
]);

/** Non-shooting equipment. */
export const UTILITY: ReadonlySet<string> = new Set([
  "weapon_healthshot", "item_assaultsuit", "item_kevlar", "weapon_diversion",
  "weapon_breachcharge", "weapon_bumpmine", "weapon_c4", "weapon_tablet", "weapon_taser",
  "weapon_shield", "weapon_snowball", ...GRENADES,
]);

/** Gear slot indices, matching the C# `gear_slot_t` mapping. */
/**
 * INTERNAL classification only — these are NOT the game's `gear_slot_t` values.
 *
 * They agree for Rifle/Pistol/Knife/C4 (0/1/2/4) but `Utility = 3` is the game's
 * `GEAR_SLOT_GRENADES`; its `GEAR_SLOT_UTILITY` is 12. Harmless while {@link slotOf} is a static
 * classification by class name and nothing reads `m_GearSlot` off a weapon — but the moment anything
 * does, these must be reconciled rather than assumed to line up.
 */
export const enum GearSlot {
  Rifle = 0,
  Pistol = 1,
  Knife = 2,
  Utility = 3,
  C4 = 4,
}

/**
 * Which gear slot a weapon class occupies. The C# read `VData.GearSlot` off the weapon entity;
 * that field is not exposed through the schema here, so this is a static classification — which is
 * also considerably cheaper than a pointer-chain read per weapon per call.
 */
export function slotOf(className: string): GearSlot {
  if (PISTOLS.has(className)) return GearSlot.Pistol;
  if (KNIVES.has(className)) return GearSlot.Knife;
  if (className === "weapon_c4") return GearSlot.C4;
  if (UTILITY.has(className)) return GearSlot.Utility;
  return GearSlot.Rifle;
}

/** Normalise a short config name ("m4a1", "taser") to a full weapon class. */
export function resolveWeapon(name: string): string {
  if (name.startsWith("weapon_") || name.startsWith("item_")) return name;
  const short = name.toLowerCase();
  switch (short) {
    case "knife": return CsItem.DefaultKnifeT;
    case "pistol": return CsItem.Glock;
    case "rifle": return CsItem.M4A1S;
    case "taser": return CsItem.Taser;
    case "m4a1": return CsItem.M4A1S;
    case "usps": return CsItem.USPS;
    case "revolver": return CsItem.Revolver;
    case "smoke": return CsItem.Smoke;
    case "c4": return CsItem.C4;
    case "awp": return CsItem.AWP;
    case "healthshot": return CsItem.Healthshot;
    default: return `weapon_${short}`;
  }
}

/** Give a weapon, optionally overriding its magazine and reserve ammo. */
export function give(
  slot: number,
  className: string,
  clip?: number,
  reserve?: number,
): HeldWeapon | null {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return null;
  const w = pawn.giveNamedItem(resolveWeapon(className)) as HeldWeapon | null;
  if (w === null) return null;
  // `setAmmo`, not a `reserveAmmo` assignment. The local shim this file used to carry declared a
  // `reserveAmmo` property that does not exist on `Weapon`; because the shim made the object `any`,
  // the assignment compiled and silently did nothing, so every reserve argument here was discarded.
  // (The SDK notes reserve itself is currently deferred pending the m_pReserveAmmo layout, so this
  // sets the magazine reliably and asks for the reserve.)
  if (clip !== undefined || reserve !== undefined) w.setAmmo(clip ?? w.clip1 ?? 0, reserve);
  return w;
}

/** Every weapon this player holds. Empty when the pawn is gone. */
export function heldWeapons(slot: number): HeldWeapon[] {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return [];
  return pawn.weapons as HeldWeapon[];
}

/** Remove every weapon occupying `gearSlot`. */
export function clearSlot(slot: number, gearSlot: GearSlot): number {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return 0;
  let removed = 0;
  const held = pawn.weapons as HeldWeapon[];
  for (let i = 0; i < held.length; i++) {
    const w = held[i]!;
    const cls = weaponClass(w);
    if (cls !== "" && slotOf(cls) === gearSlot && pawn.removeWeapon(w)) removed++;
  }
  return removed;
}

/** Strip every held weapon. */
export function stripAll(slot: number): void {
  pawnOf(slot)?.stripWeapons();
}

/** Does this player hold a weapon of `className`? */
export function holds(slot: number, className: string): boolean {
  const pawn = pawnOf(slot);
  if (pawn === null) return false;
  const target = resolveWeapon(className);
  const held = pawn.weapons as HeldWeapon[];
  for (let i = 0; i < held.length; i++) if (weaponClass(held[i]!) === target) return true;
  return false;
}
