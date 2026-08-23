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

import { nextPreFrame } from "../core/preframe";

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

/**
 * Item-definition indices that occupy the PISTOL slot. Same set the fire hook uses for its pistol
 * test, and the reason this file can classify a held weapon at all: the class NAME is not readable
 * (see `weaponClass`), but the definition index is a plain schema field.
 */
const PISTOL_DEFS: ReadonlySet<number> = new Set([1, 2, 3, 4, 30, 32, 36, 61, 63, 64]);
/** Knife definition indices: the two default knives, plus every purchasable knife (500+). */
const KNIFE_DEFS: ReadonlySet<number> = new Set([42, 59]);
/** Grenades and utility. */
const UTILITY_DEFS: ReadonlySet<number> = new Set([43, 44, 45, 46, 47, 48, 68]);
const C4_DEF = 49;

/**
 * A held weapon's definition index, or -1.
 *
 * `m_iItemDefinitionIndex` sits behind two embedded structs — `m_AttributeManager.m_Item` — and is a
 * normal schema read the whole way, unlike the class name.
 */
export function weaponDef(w: HeldWeapon | null | undefined): number {
  if (w === null || w === undefined) return -1;
  return w.attributeManager.item.itemDefinitionIndex ?? -1;
}

/** Which gear slot a definition index occupies. The by-index counterpart of {@link slotOf}. */
export function slotOfDef(def: number): GearSlot {
  if (def < 0) return GearSlot.Rifle;
  if (PISTOL_DEFS.has(def)) return GearSlot.Pistol;
  if (KNIFE_DEFS.has(def) || def >= 500) return GearSlot.Knife;
  if (def === C4_DEF) return GearSlot.C4;
  if (UTILITY_DEFS.has(def)) return GearSlot.Utility;
  return GearSlot.Rifle;
}

/**
 * Remove every weapon occupying `gearSlot`.
 *
 * Classifies by DEFINITION INDEX, not class name. It used to go through `weaponClass`, which returns
 * "" on this runtime because neither `className` nor `designerName` is readable off a weapon — so the
 * loop matched nothing and cleared nothing. That is why a purchased gun landed on the FLOOR: the slot
 * was still occupied, so the engine had nowhere to put the new weapon.
 */
export function clearSlot(slot: number, gearSlot: GearSlot): number {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return 0;
  let removed = 0;
  const held = pawn.weapons as HeldWeapon[];
  for (let i = 0; i < held.length; i++) {
    const w = held[i]!;
    if (slotOfDef(weaponDef(w)) === gearSlot && pawn.removeWeapon(w)) removed++;
  }
  return removed;
}

/**
 * Remove every held weapon whose item-definition index is `def`. Returns how many were removed.
 *
 * Matching on the DEFINITION INDEX, not on a class name: `weaponClass(w)` returns `""` on this
 * runtime, so any `weaponClass(w) === "weapon_x"` comparison silently never matches. A caller that
 * meant to replace a weapon therefore removed nothing and simply added a second one — and because
 * the engine allows only one taser, the surplus was dropped on the floor.
 */
export function removeByDef(slot: number, def: number): number {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return 0;
  let removed = 0;
  const held = pawn.weapons as HeldWeapon[];
  for (let i = 0; i < held.length; i++) {
    const w = held[i]!;
    if (weaponDef(w) === def && pawn.removeWeapon(w)) removed++;
  }
  return removed;
}

/** CS2 item-definition index for `weapon_taser`. */
export const TASER_DEF = 31;

/**
 * Free a gear slot, then hand over `className` on the FOLLOWING frame.
 *
 * `removeWeapon` does not free the inventory slot within the same frame — the engine completes the
 * removal later — so a `clearSlot(...)` immediately followed by a `give(...)` still hands the weapon
 * to a player whose slot is occupied, and the engine drops the surplus on the floor. That is how
 * buying the one-shot Revolver put it at the Detective's feet instead of in their hand, and how the
 * Taser produced one in hand and a second on the ground.
 *
 * A frame is imperceptible to the player and is the same trick `applyLoadout` already uses when a
 * role change respawns the pawn out from under a loadout write.
 */
export function replaceInSlot(
  slot: number,
  gearSlot: GearSlot,
  className: string,
  clip?: number,
  reserve?: number,
): void {
  clearSlot(slot, gearSlot);
  nextPreFrame(() => {
    give(slot, className, clip, reserve);
  }, { slot });
}

/**
 * Hand over `classNames`, first freeing the slot each one will occupy.
 *
 * The rule for every shop weapon: a purchase REPLACES what the player is holding in that slot. The
 * engine has nowhere to put a second weapon of the same kind and drops the surplus on the floor —
 * which loses the buyer the thing they paid for and leaves a free weapon lying around for whoever
 * walks past. That is how the one-shot Revolver, the silent AWP, the M4A1 bundle, the Taser and the
 * Detective's starting revolver all ended up at their owner's feet.
 *
 * UTILITY is deliberately exempt: grenades and healthshots are consumables that stack to a limit, so
 * "replace what you have" would mean buying a second grenade destroyed the first.
 *
 * The give is deferred one frame because `removeWeapon` does not release the slot until then — the
 * half of the fix that is easy to miss, since clearing alone looks correct.
 */
export function giveReplacing(slot: number, classNames: readonly string[]): void {
  if (classNames.length === 0) return;
  const seen = new Set<GearSlot>();
  for (let i = 0; i < classNames.length; i++) {
    const gear = slotOf(resolveWeapon(classNames[i]!));
    if (gear === GearSlot.Utility || seen.has(gear)) continue;
    seen.add(gear);
    clearSlot(slot, gear);
  }
  nextPreFrame(() => {
    for (let i = 0; i < classNames.length; i++) give(slot, classNames[i]!);
  }, { slot });
}

/** Strip every held weapon. */
export function stripAll(slot: number): void {
  pawnOf(slot)?.stripWeapons();
}

/**
 * Strip the primary weapon and utility, keeping the KNIFE and any PISTOL.
 *
 * What a round reset actually wants. A blanket `stripAll` leaves a player with no melee at all, and
 * the stock Innocent and Traitor loadouts are empty, so it would spawn most of the server unable to
 * do anything. Keeping a sidearm as well means a round starts the way TTT expects — knife and pistol,
 * everything heavier earned or bought during the round — so what carries over is the rifle someone
 * bought last round, which is the thing that actually unbalances the next one.
 *
 * Grenades and the C4 go: a stockpiled utility slot carries over just as unfairly as a rifle.
 *
 * Only possible because weapons are classified by definition index — `weaponClass` returns "" here.
 */
export function stripToSidearms(slot: number): number {
  const pawn = pawnOf(slot);
  if (pawn === null || !pawn.isValid) return 0;
  let removed = 0;
  const held = pawn.weapons as HeldWeapon[];
  for (let i = 0; i < held.length; i++) {
    const w = held[i]!;
    const gear = slotOfDef(weaponDef(w));
    if (gear === GearSlot.Knife || gear === GearSlot.Pistol) continue;
    if (pawn.removeWeapon(w)) removed++;
  }
  return removed;
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
