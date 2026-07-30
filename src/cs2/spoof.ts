/**
 * The "still alive" illusion — the port of `IAliveSpoofer` / `CS2AliveSpoofer`.
 *
 * TTT hides deaths, so a dead player must keep reading as alive on every other client's scoreboard
 * until their corpse is found. `CCSPlayerController::m_bPawnIsAlive` is server-authoritative and the
 * engine re-derives it, so a single write does not stick — the C# handled that by re-writing the
 * flag for every spoofed player on **every tick**, through a `HashSet<CCSPlayerController>` that it
 * also swept for invalid handles each tick.
 *
 * The re-assert has to run EVERY frame. Throttling it — even to 10 Hz — makes the scoreboard
 * visibly flicker between alive and dead, because the engine re-derives the flag in between and a
 * snapshot goes out carrying the real value. The saving is not worth it: the loop is over the
 * spoofed slots only (usually a handful), doing one field write each.
 */

import { MAX_SLOTS } from "../core/enums";
import { Player } from "@s2script/cs2";
import { setPawnHealth, setPawnIsAlive, setPawnLifeStateDead } from "./pawn";
import { isConnected } from "../core/registry";

/** Slots currently being spoofed as alive. */
const spoofed: number[] = [];
/** Membership test without scanning `spoofed`. */
const isSpoofed = new Uint8Array(MAX_SLOTS);

/** Begin spoofing `slot` as alive. */
/** The health each spoofed slot is presented as having; captured when the spoof starts. */
const heldHealth = new Int32Array(MAX_SLOTS);

export function spoofAlive(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS || isSpoofed[slot] === 1) return;
  isSpoofed[slot] = 1;
  spoofed.push(slot);
  // Whatever the controller last mirrored, floored at 1: this is called from the death PRE-hook, so
  // the mirror still holds the pre-death value. A 0 here would present a living player on 0 health,
  // which reads as dead on any scoreboard that shows it.
  const seen = Player.fromSlot(slot)?.pawnHealth ?? 100;
  heldHealth[slot] = seen > 0 ? seen : 100;
  setPawnIsAlive(slot, true);
  setPawnHealth(slot, heldHealth[slot]!);
}

/**
 * Drop the spoof for a slot that is now genuinely ALIVE — a respawn.
 *
 * Distinct from {@link unspoofAlive}, which writes real DEAD state, and the distinction is not
 * cosmetic: `onSpawn` called `unspoofAlive`, so every respawn wrote `lifeState = LIFE_DEAD` onto the
 * pawn that had just spawned and killed it again. That was invisible while the per-frame ticker
 * re-asserted `LIFE_ALIVE` — it simply undid the damage a frame later — but the moment the ticker
 * stopped touching `lifeState` (so dead players could reach freecam), respawns stopped working
 * entirely: `respawn()` reported success every second while the player stayed dead on the floor.
 *
 * A player who has just spawned needs NO writes at all. The engine has already set their state
 * correctly; the only thing to undo is our own bookkeeping.
 */
export function clearSpoof(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS || isSpoofed[slot] === 0) return;
  isSpoofed[slot] = 0;
  const i = spoofed.indexOf(slot);
  if (i >= 0) spoofed.splice(i, 1);
}

/** Stop spoofing `slot` and let them read as dead. Use {@link clearSpoof} after a RESPAWN. */
export function unspoofAlive(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS || isSpoofed[slot] === 0) return;
  isSpoofed[slot] = 0;
  const i = spoofed.indexOf(slot);
  if (i >= 0) spoofed.splice(i, 1);
  // Undo EVERY write the illusion made, in the reverse order it made them.
  //
  // The tick writes three things — pawn `lifeState`, the controller's `m_bPawnIsAlive` mirror, and
  // the mirrored health — but this used to clear only the mirror flag. The pawn stayed LIFE_ALIVE
  // with health restored, and since the controller re-derives its mirror FROM the pawn a few frames
  // later, the flag went straight back to alive: identifying a body revealed the role but left its
  // owner showing as alive on the scoreboard for the rest of the round.
  setPawnLifeStateDead(slot);
  setPawnHealth(slot, 0);
  setPawnIsAlive(slot, false);
}

/**
 * Re-assert one slot's flag immediately after the engine has written its own.
 *
 * `handleDeath` spoofs from the player_death PRE-hook, which runs BEFORE the engine processes the
 * death — so the engine then sets `pawnIsAlive` false and the value replicates that way. The
 * per-frame ticker only puts it back on the NEXT frame, and that one-frame window is visible: the
 * scoreboard shows the player dead and then flips back, which is exactly the death this mode exists
 * to hide.
 *
 * Called from the POST hook for the same event, so the sequence completes inside one frame.
 */
export function reassertSpoof(slot: number): void {
  if (spoofing(slot) && spoofingEnabled) setPawnIsAlive(slot, true);
}

/** Is this slot currently pretending to be alive? */
export function spoofing(slot: number): boolean {
  return slot >= 0 && slot < MAX_SLOTS && isSpoofed[slot] === 1;
}

/**
 * Re-assert the flag for every spoofed player. Called from the plugin's shared frame handler; a
 * no-op (one comparison) while nobody is spoofed, which is most of a round's first minute.
 */
export function tickSpoof(): void {
  if (spoofed.length === 0 || !spoofingEnabled) return;

  for (let i = spoofed.length - 1; i >= 0; i--) {
    const slot = spoofed[i]!;
    if (!isConnected(slot)) {
      isSpoofed[slot] = 0;
      spoofed.splice(i, 1);
      continue;
    }
    // ONLY the controller's mirror — the value every OTHER client's scoreboard reads, so
    // re-asserting it every frame keeps it correct without touching the victim's own view.
    //
    // THE PAWN'S `lifeState` IS DELIBERATELY NOT WRITTEN. It was, for a while, as an explicit trade:
    // the kill feed stayed visible to Innocents no matter how thoroughly the death event was
    // suppressed, and holding the pawn at LIFE_ALIVE was the only thing that hid it — a client that
    // never observes the death never synthesises a feed entry. The cost was that the VICTIM'S OWN
    // client reads this same field to decide it has died, so a pawn pinned to LIFE_ALIVE never let
    // them into observer mode: they spent the rest of the round locked to a camera above their
    // corpse, their killer frozen on screen, unable to spectate anyone.
    //
    // That trade rested on a false premise. The suppression it was compensating for was not failing
    // for want of this write — every `player_death` pre-hook was throwing a TypeError on its final
    // `return HookResult.Handled` statement, so the result never reached the collapse and the engine
    // broadcast the death to everyone. With that fixed, scoped suppression demonstrably works (the
    // per-client post is dropped for non-killers, confirmed on a live server), so the feed stays
    // hidden with the pawn left alone and the victim gets their spectator camera back.
    setPawnIsAlive(slot, true);
    setPawnHealth(slot, heldHealth[slot]!);
  }
}

/**
 * Whether the illusion is being maintained at all.
 *
 * Turned off the moment a round ends: `revealRoles` writes each player's REAL liveness at that
 * point, and a spoofer still running would overwrite it on the next frame and keep the dead
 * reading as alive through the whole end-of-round screen.
 */
let spoofingEnabled = true;

/** Stop maintaining the illusion (round end) or resume it (round start). */
export function setSpoofingEnabled(on: boolean): void {
  spoofingEnabled = on;
}

/** Clear every spoof (round boundary / map change). */
export function resetSpoof(): void {
  for (let i = 0; i < spoofed.length; i++) isSpoofed[spoofed[i]!] = 0;
  spoofed.length = 0;
  spoofingEnabled = true;
}
