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
import { setPawnIsAlive } from "./pawn";
import { isConnected } from "../core/registry";

/** Slots currently being spoofed as alive. */
const spoofed: number[] = [];
/** Membership test without scanning `spoofed`. */
const isSpoofed = new Uint8Array(MAX_SLOTS);

/** Begin spoofing `slot` as alive. */
export function spoofAlive(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS || isSpoofed[slot] === 1) return;
  isSpoofed[slot] = 1;
  spoofed.push(slot);
  setPawnIsAlive(slot, true);
}

/** Stop spoofing `slot` and let them read as dead. */
export function unspoofAlive(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS || isSpoofed[slot] === 0) return;
  isSpoofed[slot] = 0;
  const i = spoofed.indexOf(slot);
  if (i >= 0) spoofed.splice(i, 1);
  setPawnIsAlive(slot, false);
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
  if (spoofed.length === 0) return;

  for (let i = spoofed.length - 1; i >= 0; i--) {
    const slot = spoofed[i]!;
    if (!isConnected(slot)) {
      isSpoofed[slot] = 0;
      spoofed.splice(i, 1);
      continue;
    }
    setPawnIsAlive(slot, true);
  }
}

/** Clear every spoof (round boundary / map change). */
export function resetSpoof(): void {
  for (let i = 0; i < spoofed.length; i++) isSpoofed[spoofed[i]!] = 0;
  spoofed.length = 0;
}
