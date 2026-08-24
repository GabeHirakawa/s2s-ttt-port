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

/** Hard cap on waiting jobs. Newest arrivals are dropped and logged. */
export const PREFRAME_MAX_QUEUED = 256;
/** Hard cap on jobs drained in one PRE tick. Overflow is pushed to the following frame. */
export const PREFRAME_MAX_DRAIN = 128;

export interface PreFrameHandle {
  cancel(): void;
}

export interface PreFrameOpts {
  /** If set, the job is dropped when this slot's SteamID or connection generation changes. */
  slot?: number;
}

export interface PreFrameIdentity {
  steamId: string;
  gen: number;
}

interface Job {
  fn: () => void;
  map: number;
  round: number;
  slot: number;
  steamId: string;
  gen: number;
  canceled: boolean;
}

/** Callbacks waiting for the next PRE tick. */
let queued: Job[] = [];
let mapEpoch = 0;
let getRoundEpoch: () => number = () => 0;
let identityOf: (slot: number) => PreFrameIdentity = () => ({ steamId: "", gen: 0 });
let dropped = 0;
let highWater = 0;

/** Bump on map start and unload so in-flight jobs cannot fire into a new world. */
export function bumpMapEpoch(): void {
  mapEpoch++;
}

export function currentMapEpoch(): number {
  return mapEpoch;
}

/** Bind the round-timer generation. Called once from `initGame`. */
export function bindRoundEpoch(fn: () => number): void {
  getRoundEpoch = fn;
}

/** Bind slot identity lookup. Called once from the plugin factory. */
export function bindPreFrameIdentity(fn: (slot: number) => PreFrameIdentity): void {
  identityOf = fn;
}

export function preFrameDepth(): number {
  return queued.length;
}

export function preFrameDropped(): number {
  return dropped;
}

export function preFrameHighWater(): number {
  return highWater;
}

/**
 * Run `fn` at the start of the next PRE game frame, before the engine simulates.
 *
 * The direct replacement for `void nextFrame().then(fn)` wherever `fn` touches a networked entity.
 * Jobs are stamped with the current map/round epochs and, when `opts.slot` is set, the occupant
 * identity so a reconnect into the same slot cannot inherit a stale weapon or model swap.
 */
export function nextPreFrame(fn: () => void, opts?: PreFrameOpts): PreFrameHandle {
  if (queued.length >= PREFRAME_MAX_QUEUED) {
    dropped++;
    console.log(`[ttt] WARN: pre-frame queue full (${String(PREFRAME_MAX_QUEUED)}); dropping newest`);
    return { cancel() { /* already dropped */ } };
  }
  const slot = opts?.slot ?? -1;
  const ident = slot >= 0 ? identityOf(slot) : { steamId: "", gen: 0 };
  const job: Job = {
    fn,
    map: mapEpoch,
    round: getRoundEpoch(),
    slot,
    steamId: ident.steamId,
    gen: ident.gen,
    canceled: false,
  };
  queued.push(job);
  if (queued.length > highWater) highWater = queued.length;
  return {
    cancel() {
      job.canceled = true;
    },
  };
}

function jobStale(job: Job): boolean {
  if (job.canceled) return true;
  if (job.map !== mapEpoch) return true;
  if (job.round !== getRoundEpoch()) return true;
  if (job.slot < 0) return false;
  const ident = identityOf(job.slot);
  return ident.steamId !== job.steamId || ident.gen !== job.gen;
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
  const limit = due.length > PREFRAME_MAX_DRAIN ? PREFRAME_MAX_DRAIN : due.length;
  for (let i = 0; i < limit; i++) {
    const job = due[i]!;
    if (jobStale(job)) continue;
    try {
      job.fn();
    } catch (e) {
      console.log(`[ttt] WARN: pre-frame callback threw: ${String(e)}`);
    }
  }
  if (limit < due.length) {
    const rest = due.slice(limit);
    queued = rest.concat(queued);
  }
}

/** Drop everything queued — map change and unload, so nothing fires into a dead round. */
export function clearPreFrame(): void {
  queued = [];
}
