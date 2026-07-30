/**
 * The shop catalogue — the port of every `IShopItem` under `TTT/Shop/Items` and `TTT/CS2/Items`.
 *
 * Each C# item was a DI-registered class (six injected services in its base constructor) whose
 * `Config` property re-loaded a config record from storage on every read, plus a matching
 * `IStorage<T>` implementation and a `*ServiceCollection` registration. That is ~5 files and a
 * container round-trip per item. Here an item is one object literal with a `refresh()` that reads
 * the config snapshot at round boundaries.
 *
 * Items whose effect is an ongoing behaviour (poison, gloves, stickers, …) set a flag in a slot-indexed
 * array; the corresponding listener in `effects.ts` reads that flag on the relevant event.
 */

import { RoleId } from "../core/enums";
import { n, list, s as str } from "../core/cvars";
import { msg, msgFor } from "../core/msgs";
import { giveArmorWithHelmet } from "../cs2/handlers";
import { armStickers } from "../cs2/icons";
import { clearSlot, GearSlot, give, giveReplacing, replaceInSlot } from "../cs2/inventory";
import { nextFrame } from "@s2script/sdk/timers";
import { tell } from "../cs2/pawn";
import { register, type ShopItem, PurchaseResult } from "./shop";
import * as fx from "./effects";
import * as wfx from "./weaponfx";

/** Build a plain item descriptor. */
function item(
  id: string,
  nameKey: string,
  descKey: string,
  role: RoleId,
  priceCvar: string,
  onPurchase: (slot: number) => void,
  extra?: Partial<ShopItem>,
): ShopItem {
  const it: ShopItem = {
    id,
    nameKey,
    descKey,
    price: 0,
    role,
    limit: 0,
    refresh() {
      it.price = n(priceCvar);
      extra?.refresh?.();
    },
    onPurchase,
    ...(extra?.canPurchase !== undefined ? { canPurchase: extra.canPurchase } : {}),
  };
  if (extra?.limit !== undefined) it.limit = extra.limit;
  return it;
}

/** Register every shop item, in the order they appear in the C# `ShopServiceCollection`. */
export function registerItems(): void {
  // ── universal ─────────────────────────────────────────────────────────────
  register(
    item("armor", "SHOP_ITEM_ARMOR", "SHOP_ITEM_ARMOR_DESC", RoleId.None, "sm_ttt_shop_armor_price", (slot) => {
      // `ArmorItem.OnPurchase` is `SetArmor(config.Armor, config.Helmet)` and `ArmorConfig.Helmet`
      // ships `true`, so the item has always included the helmet — a bare armor value leaves the
      // buyer taking full headshot damage, which is most of what they paid for.
      giveArmorWithHelmet(slot, n("sm_ttt_shop_armor_amount"));
    }),
  );

  register(
    item("healthshot", "SHOP_ITEM_HEALTHSHOT", "SHOP_ITEM_HEALTHSHOT_DESC", RoleId.None, "sm_ttt_shop_healthshot_price", (slot) => {
      give(slot, "weapon_healthshot");
    }, { limit: 2, refresh: () => undefined }),
  );

  register(
    item("m4a1", "SHOP_ITEM_M4A1", "SHOP_ITEM_M4A1_DESC", RoleId.None, "sm_ttt_shop_m4a1_price", (slot) => {
      // `sm_ttt_shop_m4a1_clear_slots` is an OPERATOR extra — slots to empty beyond the ones this
      // bundle needs. The bundle's own slots are freed by `giveReplacing` regardless, so an empty or
      // mis-set cvar can no longer cause the purchase to be dropped on the floor.
      for (const raw of list("sm_ttt_shop_m4a1_clear_slots")) {
        const idx = parseInt(raw, 10);
        if (Number.isFinite(idx)) clearSlot(slot, idx as GearSlot);
      }
      giveReplacing(slot, list("sm_ttt_shop_m4a1_weapons"));
    }),
  );

  register(
    item("taser", "SHOP_ITEM_TASER", "SHOP_ITEM_TASER_DESC", RoleId.None, "sm_ttt_shop_taser_price", (slot) => {
      // `grantTaser` is the whole of `TaserItem.OnPurchase`: remove-then-give of the CONFIGURED
      // weapon, so re-buying refreshes a spent taser. A hard-coded `give("weapon_taser")` here both
      // duplicated that grant and ignored `sm_ttt_shop_taser_weapon`.
      fx.grantTaser(slot);
    }),
  );

  // ── detective ─────────────────────────────────────────────────────────────
  register(
    item("deagle", "SHOP_ITEM_DEAGLE", "SHOP_ITEM_DEAGLE_DESC", RoleId.Detective, "sm_ttt_shop_onedeagle_price", (slot) => {
      // Deferred by a frame — see `replaceInSlot`. A same-frame give landed while the pistol slot was
      // still occupied and the engine dropped the revolver at the Detective's feet.
      replaceInSlot(slot, GearSlot.Pistol, str("sm_ttt_shop_onedeagle_weapon"), 1, 0);
      fx.grantOneShotRevolver(slot);
    }, { limit: 1 }),
  );

  register(
    item("stickers", "SHOP_ITEM_STICKERS", "SHOP_ITEM_STICKERS_DESC", RoleId.Detective, "sm_ttt_shop_stickers_price", (slot) => {
      fx.grantStickers(slot);
      // The item's actual payoff is the PERSISTENT reveal: the C# `StickerListener` calls
      // `IIconManager.RevealToAll`, which makes the tased player's role icon transmit to every
      // client for the rest of the round. `fx.grantStickers` only arms the chat notification;
      // this arms the icon reveal in `icons.ts`, which owns the marker itself.
      armStickers(slot);
    }, { limit: 1 }),
  );

  register(
    item("dna", "SHOP_ITEM_DNA", "SHOP_ITEM_DNA_DESC", RoleId.Detective, "sm_ttt_shop_dna_price", (slot) => {
      fx.grantDnaScanner(slot);
    }, { limit: 1 }),
  );

  register(
    item("healthstation", "SHOP_ITEM_STATION_HEALTH", "SHOP_ITEM_STATION_HEALTH_DESC", RoleId.Detective, "sm_ttt_shop_healthstation_price", (slot) => {
      return fx.placeStation(slot, n("sm_ttt_shop_healthstation_increments"));
    }),
  );

  register(
    item("compass_body", "SHOP_ITEM_COMPASS_BODY", "SHOP_ITEM_COMPASS_BODY_DESC", RoleId.Detective, "sm_ttt_shop_compass_price", (slot) => {
      fx.grantCompass(slot, fx.CompassMode.Bodies);
    }, { limit: 1 }),
  );

  // ── traitor ───────────────────────────────────────────────────────────────
  register(
    item("c4", "SHOP_ITEM_C4", "SHOP_ITEM_C4_DESC", RoleId.Traitor, "sm_ttt_shop_c4_price", (slot) => {
      giveReplacing(slot, ["weapon_c4"]);
      fx.grantC4();
      wfx.applyC4Fuse();
    }, {
      limit: 0,
      canPurchase: (slot) =>
        fx.c4Count() >= n("sm_ttt_shop_c4_max_at_once") && n("sm_ttt_shop_c4_max_at_once") > 0
          ? PurchaseResult.NotPurchasable
          : PurchaseResult.Success,
    }),
  );

  register(
    item("gloves", "SHOP_ITEM_GLOVES", "SHOP_ITEM_GLOVES_DESC", RoleId.Traitor, "sm_ttt_shop_gloves_price", (slot) => {
      fx.grantGloves(slot, n("sm_ttt_shop_gloves_max_uses"));
    }, { limit: 1 }),
  );

  register(
    item("camo", "SHOP_ITEM_CAMO", "SHOP_ITEM_CAMO_DESC", RoleId.Traitor, "sm_ttt_shop_camo_price", (slot) => {
      fx.grantCamo(slot);
    }, { limit: 1 }),
  );

  register(
    item("bodypaint", "SHOP_ITEM_BODY_PAINT", "SHOP_ITEM_BODY_PAINT_DESC", RoleId.Traitor, "sm_ttt_shop_bodypaint_price", (slot) => {
      fx.grantBodyPaint(slot, n("sm_ttt_shop_bodypaint_max_uses"));
    }, { limit: 1 }),
  );

  register(
    item("onehitknife", "SHOP_ITEM_ONE_HIT_KNIFE", "SHOP_ITEM_ONE_HIT_KNIFE_DESC", RoleId.Traitor, "sm_ttt_shop_onehitknife_price", (slot) => {
      fx.grantOneHitKnife(slot);
    }, { limit: 1 }),
  );

  register(
    item("silentawp", "SHOP_ITEM_SILENT_AWP", "SHOP_ITEM_SILENT_AWP_DESC", RoleId.Traitor, "sm_ttt_shop_silentawp_price", (slot) => {
      // Free the primary slot first, or the engine has nowhere to put the AWP and drops it at the
      // buyer's feet — which also means they never hold it, so its silenced-shot grant does nothing.
      // The give is deferred a frame because the slot is not actually free until then; see
      // `replaceInSlot`.
      replaceInSlot(
        slot,
        GearSlot.Rifle,
        "weapon_awp",
        n("sm_ttt_shop_silentawp_current_ammo"),
        n("sm_ttt_shop_silentawp_reserve_ammo"),
      );
      wfx.grantSilentShots(
        slot,
        n("sm_ttt_shop_silentawp_current_ammo") + n("sm_ttt_shop_silentawp_reserve_ammo"),
      );
    }, { limit: 1 }),
  );

  register(
    item("poisonsmoke", "SHOP_ITEM_POISON_SMOKE", "SHOP_ITEM_POISON_SMOKE_DESC", RoleId.Traitor, "sm_ttt_shop_poisonsmoke_price", (slot) => {
      give(slot, "weapon_smokegrenade");
      wfx.armPoisonSmoke(slot);
    }, { limit: 1 }),
  );

  register(
    item("poisonshots", "SHOP_ITEM_POISON_SHOTS", "SHOP_ITEM_POISON_SHOTS_DESC", RoleId.Traitor, "sm_ttt_shop_poisonshots_price", (slot) => {
      // The counter lives in `weaponfx.ts`, not `effects.ts`: a charge is spent on FIRE (and the
      // same counter silences the pistol through the shared fire-sound hook), while `effects.ts`
      // only READS it to decide whether a landed pistol hit poisons.
      wfx.grantPoisonShots(slot, n("sm_ttt_shop_poisonshots_total"));
    }, { limit: 1 }),
  );

  register(
    item("clustergrenade", "SHOP_ITEM_CLUSTER_GRENADE", "SHOP_ITEM_CLUSTER_GRENADE_DESC", RoleId.Traitor, "sm_ttt_shop_clustergrenade_price", (slot) => {
      give(slot, "weapon_hegrenade");
      wfx.armCluster(slot);
    }, { limit: 1 }),
  );

  register(
    item("damagestation", "SHOP_ITEM_STATION_HURT", "SHOP_ITEM_STATION_HURT_DESC", RoleId.Traitor, "sm_ttt_shop_damagestation_price", (slot) => {
      return fx.placeStation(slot, n("sm_ttt_shop_damagestation_increments"));
    }, { limit: 3 }),
  );

  register(
    item("compass_player", "SHOP_ITEM_COMPASS_PLAYER", "SHOP_ITEM_COMPASS_PLAYER_DESC", RoleId.Traitor, "sm_ttt_shop_compass_price", (slot) => {
      fx.grantCompass(slot, fx.CompassMode.Players);
    }, { limit: 1 }),
  );

  register(
    item("tripwire", "SHOP_ITEM_TRIPWIRE", "SHOP_ITEM_TRIPWIRE_DESC", RoleId.Traitor, "sm_ttt_shop_tripwire_price", (slot) => {
      // Returns false so `tryPurchase` refunds: refusing the placement AND keeping the credits is
      // the worst of both, and "too far away" is a miss, not a purchase.
      if (fx.placeTripwire(slot)) return true;
      tell(slot, msgFor(slot, "SHOP_ITEM_TRIPWIRE_TOOFAR"));
      return false;
    }),
  );
}
