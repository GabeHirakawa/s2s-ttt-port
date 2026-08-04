/**
 * "Run this next frame, BEFORE the engine simulates" — the port of CounterStrikeSharp's
 * `Server.NextWorldUpdate`.
 *
 * ## Why this exists instead of `nextFrame()`
 *
 * s2script resolves EVERY promise — `nextFrame`, `nextTick`, `delay`, `after`, `every` — from a
 * single drain that core calls only in the `GameFrame` **POST** hook:
 *
 *     if phase == Phase::Post { v8host::frame_async_drain(); }
 *
 * Both reference implementations drain **PRE**. SourceMod's whole timer system hangs off
 * `SH_ADD_HOOK(IServerGameDLL, GameFrame, ..., false)` — `false` is a pre-hook — and CounterStrikeSharp
 * wires `Server.NextWorldUpdate` to `AddListener("OnServerPreWorldUpdate", ...)`. s2script is the odd
 * one out, and `timers.d.ts` says only "yield until the next game frame", so nothing warns you.
 *
 * The phase is not a detail for anything touching entities. A Source 2 frame runs:
 *
 *     GameFrame PRE  ->  simulation (think, physics, ENTITY I/O SERVICED)  ->  GameFrame POST  ->  snapshot
 *
 * `Kill` is an entity-I/O input, so indices are released during simulation. A POST callback therefore
 * runs at the precise moment the free list is freshest, and anything it creates can claim an index
 * released moments earlier — with no snapshot in between to tell clients the old entity died. The
 * client is then handed one delta in which an index silently changed identity, which is what
 * `CopyExistingEntity: missing client entity N` reports. Draining PRE puts a full snapshot between
 * the release and the reuse, which is what the reference implementations get for free.
 *
 * ## Use this for anything that creates, destroys, re-parents or teleports a networked entity
 *
 * `nextFrame()` is still correct for bookkeeping, chat, HUD text and other non-entity work.
 *
 * The queue is drained from the plugin's own `onGameFrame` tick, which subscribes with no `phase`
 * option — and core defaults a subscription to `Phase::Pre` (`let mut phase = Phase::Pre`). So this
 * needs no runtime change; it just stops routing entity work through the POST drain.
 */

/** Callbacks waiting for the next PRE tick. */
let queued: (() => void)[] = [];

/**
 * Run `fn` at the start of the next PRE game frame, before the engine simulates.
 *
 * The direct replacement for `void nextFrame().then(fn)` wherever `fn` touches a networked entity.
 */
export function nextPreFrame(fn: () => void): void {
  queued.push(fn);
}

/**
 * Run everything queued. Called once, first, from the plugin's PRE tick.
 *
 * The list is swapped out before iterating so a callback that queues more work lands on the FOLLOWING
 * frame rather than extending this drain — otherwise a callback that re-queues itself would spin the
 * frame forever. A throwing callback is contained: it must not cost the rest of the queue its turn.
 */
export function drainPreFrame(): void {
  if (queued.length === 0) return;
  const due = queued;
  queued = [];
  for (let i = 0; i < due.length; i++) {
    try {
      due[i]!();
    } catch (e) {
      console.log(`[ttt] WARN: pre-frame callback threw: ${String(e)}`);
    }
  }
}

/** Drop everything queued — map change and unload, so nothing fires into a dead round. */
export function clearPreFrame(): void {
  queued = [];
}
