/**
 * One hide-then-Kill-then-restore teardown for map change and plugin unload.
 *
 * Hot reload used to drop transmit rules (host sweep) and then `Kill` still-networked icons, DNA
 * markers, bodies and gadgets. Clients excluded from those creates saw a one-snapshot visibility
 * burst, then a delete, then the replacement instance created entities into recycled indices —
 * `CopyExistingEntity: missing client entity N`.
 *
 * This module is the plugin-side contract: re-hide every filtered entity, queue `Kill` while the
 * hide still holds, restore engine-visible player state, and only then drop JS bookkeeping.
 * `Transmit.resetAll` is deliberately not called here; leftover hide rules on dying serials are
 * safer than a visibility burst, and the host should sweep transmit after `onUnload`.
 */

import { Server } from "@s2script/sdk/server";
import { resetSanctions } from "../rdm/sanctions";
import { resetReports } from "../rdm/reports";
import type { EventBus } from "./bus";
import type { TttEvents } from "./events";
import { bumpMapEpoch, clearPreFrame } from "./preframe";
import * as reg from "./registry";
import { abandonRound, onMapChange } from "../game/game";
import { clearReservedRoles } from "../game/roles";
import { clearBenched } from "../game/teams";
import { clearLog } from "../game/logger";
import { clearBodies } from "../cs2/bodies";
import { hideIcons, resetIcons } from "../cs2/icons";
import { resetInteract } from "../cs2/interact";
import { resetSpoof } from "../cs2/spoof";
import { resetHud } from "../cs2/hud";
import { resetAfk, unmuteAll } from "../cs2/handlers";
import { clearAppliedModels } from "../cs2/pawn";
import { hideEffects, resetEffects } from "../shop/effects";
import { hideWeaponFx, resetWeaponFx } from "../shop/weaponfx";
import { resetShop } from "../shop/shop";
import { resetShopMenus } from "../commands";
import { resetRound } from "../karma/karma";
import { clearSpecialRounds } from "../special/rounds";
import { getTttHud } from "../cs2/ttthud";

/** Why teardown is running. Unload abandons the round; map change uses the existing fold-up. */
export type TeardownReason = "unload" | "map";

/**
 * Tear down every plugin-owned world entity and restore engine-visible player state.
 *
 * @param reason - `"unload"` abandons the live round without team/respawn/loadout churn.
 *   `"map"` still goes through {@link onMapChange} (which may `endGame`) because the map is leaving.
 */
export function teardownWorld(bus: EventBus<TttEvents>, reason: TeardownReason): void {
  bumpMapEpoch();
  if (reason === "unload") {
    abandonRound();
  } else {
    onMapChange();
  }

  // Hide FIRST. Host unload may already have swept transmit; re-applying `[]` is what keeps a
  // dying Traitor glow off clients who never received its create.
  hideIcons();
  hideWeaponFx();
  hideEffects();

  // Kill while still filtered. Children-before-parents lives in each module's own destroy path.
  clearBodies(true);
  resetEffects();
  resetWeaponFx();
  resetInteract();
  resetIcons();

  clearSpecialRounds();
  resetSpoof();
  resetHud();
  // Panorama panels persist on the client until told otherwise, so an unload must clear them
  // explicitly — otherwise a reload leaves a stale badge on every traitor's screen.
  getTttHud()?.resetAll();
  unmuteAll();
  resetShopMenus();
  clearBenched();
  clearReservedRoles();
  clearPreFrame();
  resetShop();
  // A slay queue and a report queue are per-map: leaving must not dodge a sanction, but nobody
  // should carry one into a session hours later with no idea why they died.
  resetSanctions();
  resetReports();
  resetAfk();
  resetRound();
  clearAppliedModels();
  clearLog();

  if (reason === "unload") {
    // Names/voice/HUD are already back. Drop JS identity last so a throwing reset cannot leave
    // "[T] Bob" on the scoreboard because the roster was already gone.
    reg.resetRegistry();
    bus.clear();
    Server.setCvar("mp_ignore_round_win_conditions", "0");
  }
}
