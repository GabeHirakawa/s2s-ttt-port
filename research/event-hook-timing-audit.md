# CopyExistingEntity and hook-timing audit

Date: 2026-08-23

Scope:

- TTT plugin: `GabeHirakawa/s2s-ttt-port` at
  [`b557e9d61f91a1ecfb1a99590756df59ef30383a`](https://github.com/GabeHirakawa/s2s-ttt-port/commit/b557e9d61f91a1ecfb1a99590756df59ef30383a)
- canonical C# TTT: `edgegamers/TTT` at
  [`80716fba705a42ea60bfae0095b5a222e9eba7d1`](https://github.com/edgegamers/TTT/tree/80716fba705a42ea60bfae0095b5a222e9eba7d1)
- s2script: `s2script/s2script` at
  [`a835e6c77d2b648392d53686f919738193dbe10b`](https://github.com/s2script/s2script/tree/a835e6c77d2b648392d53686f919738193dbe10b)
- CounterStrikeSharp comparison: `roflmuffin/CounterStrikeSharp` at
  [`55542dba7c5318dfbb37b0862256f4dcde7cf0f4`](https://github.com/roflmuffin/CounterStrikeSharp/tree/55542dba7c5318dfbb37b0862256f4dcde7cf0f4)

Only primary sources were used: source, repository history/PRs, published package artifacts, and
first-party comments/live-gate records. There is no existing `docs/`, `notes/`, or `research/`
convention in the TTT repository, so this report establishes `research/`.

## Executive summary

The strongest reconstruction of the historical fatal is an entity-index identity transition that
was not separated by a client-visible deletion:

1. a team switch, entity I/O `Kill`, or malformed spawn retires or destabilizes an entity;
2. another networked entity is created after simulation but before the next snapshot, or a
   transmit-filtered entity claims the newly available index;
3. at least one client did not receive a compatible create/delete sequence for that index;
4. its next delta tries to copy/update an entity record that does not exist, producing
   `CopyExistingEntity: missing client entity N`.

The repository contains strong live evidence for the ingredients (Detective-biased reproduction,
`bodies off = no crash`, staging assertions, captured indices, and improvement after lifecycle
changes), but not a client packet capture or Valve source proving one unique causal chain. The
ragdoll initialization defect, POST-phase reuse window, and transmit/baseline behavior may all have
contributed. They should not be collapsed into one “proven engine bug.”

The plugin’s `nextPreFrame` change is directionally correct but incomplete. Four `delay(...).then`
continuations still run in s2script’s POST async drain. All four can directly or indirectly reach
round transitions that create, kill, respawn, switch teams, strip/give weapons, and rewrite
transmit state. The only `after` callback also changes transmit rules in POST. This directly
violates the plugin’s own documented rule that entity work must run PRE.

The checked-in package lock is also incompatible with the checked-in source. It pins
`@s2script/sdk@0.11.0` and `@s2script/cs2@0.11.1`; the published 0.11 SDK has no
`onGameFrame(..., { phase })` option and no `Events.setRecipients`, while this source uses both
(the latter behind a runtime cast). The actual deployed runtime was not recorded, so this proves a
reproducibility/migration failure, not which runtime binary was on the live server.

Recent s2script work materially improves safety:

- true PRE/POST frame subscriptions;
- a bounded, double-buffered PRE drain for re-entrant **notify-only** dispatches;
- `NestGuard`/`CallbackScope` nesting for plugin-originated engine calls;
- generation-gated timers/jobs and owner-scoped teardown;
- entity refs backed by index + engine serial + a host-minted liveness id;
- serial-gated transmit entries and filtering only for fully signed-on clients.

Those improvements do not make every callback safe. Pre-hooks still cannot be deferred when true
engine ingress finds the isolate busy; all promises/callback timers still resume POST; and
game-world entities remain plugin-owned rather than ledger-owned.

The focused framework audit found four additional current-main defects:

- nested `giveNamedItem` reaches `onCanAcquire`, but nested fan-out omits the per-handler callback
  that records acquisition votes, so a handler can run and still have its denial replaced with
  `Allowed`;
- `MAX_NEST = 8` limits recorded callback tokens, not recursion depth: overflow calls reuse the
  eighth token and continue nesting;
- `Client.kick` is not wrapped in the outbound nest, so disconnect notification is deferred;
- the nest token is extracted by scanning the private, non-`repr(C)` memory layout of
  `FunctionCallbackArguments`, making rusty_v8 layout drift a process-crash risk.

The port also has a separate commit-boundary bug. `assignRoles` emits `roleAssign` before committing
the role, while the newly synchronous `applyRoleVisuals` immediately requires that committed role.
Since `rotateRoles` first clears every live role, the visual handler exits on every normal
assignment. Correcting only that guard would reactivate the POST-phase team/icon churn above; the
event commit boundary and scheduling must be fixed together.

Finally, current s2script main has a concrete scoped-recipient regression. `Hook_FireEventPre`
sets `s_legacyFilterActive`, calls `FireEvent`, then immediately clears the filter. The adjacent
comment says that exact strategy was proven not to work because the client message is flushed later,
and claims `Hook_GameFramePost` clears it; the current POST hook performs no such clear. This is a
high-confidence kill-feed/privacy defect. A frame-global mask would still need event correlation to
handle multiple or nested suppressed events safely.

## Evidence table

| Finding | Status | Confidence | Primary evidence |
|---|---|---:|---|
| `NextWorldUpdate` is a pre-world-update queue | Proven | High | CounterStrikeSharp queues through `QueueTaskForNextWorldUpdate`; `ServerManager::PreWorldUpdate` drains up to 1024 tasks before its callback ([managed API](https://github.com/roflmuffin/CounterStrikeSharp/blob/55542dba7c5318dfbb37b0862256f4dcde7cf0f4/managed/CounterStrikeSharp.API/Server.cs#L106-L130), [native drain](https://github.com/roflmuffin/CounterStrikeSharp/blob/55542dba7c5318dfbb37b0862256f4dcde7cf0f4/src/core/managers/server_manager.cpp#L157-L190)). |
| s2script `onGameFrame` defaults PRE and supports explicit POST on current main | Proven | High | SDK contract ([`plugin.d.ts` L77-L96](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/packages/sdk/plugin.d.ts#L77-L96)); core parses default `Phase::Pre` ([`v8host.rs` L763-L786](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/v8host.rs#L763-L786)). |
| s2script promises and callback timers resume in POST | Proven | High | C ABI invokes `frame_async_drain` only for `Phase::Post` ([`ffi.rs` L80-L100](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/ffi.rs#L80-L100)); drain contract says the same ([`v8host.rs` L6231-L6245](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/v8host.rs#L6231-L6245)). |
| TTT still launches entity-heavy transitions from POST timers | Proven | High | Countdown timer calls `beginRound` ([`game.ts` L192-L195](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/game/game.ts#L192-L195)); deadline calls `endGame` ([L291-L297](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/game/game.ts#L291-L297)); end/restart timers issue `terminateRound` ([L448-L470](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/game/game.ts#L448-L470)). |
| Canonical TTT explicitly hands scheduled engine work to PRE world update | Proven | High | Its round deadline scheduler wraps `EndGame` in `Server.NextWorldUpdate` ([`RoundTimerListener.cs` L76-L81](https://github.com/edgegamers/TTT/blob/80716fba705a42ea60bfae0095b5a222e9eba7d1/TTT/CS2/Listeners/RoundTimerListener.cs#L76-L81)); inventory, AFK, station, tripwire, poison, and special-round schedulers follow the same pattern. |
| Historical delayed icon creation could follow a pawn-index retirement without an intervening snapshot | Repository/live evidence; engine consequence inferred | Medium-high | TTT’s detailed reproduction and Detective bias ([`teams.ts` L90-L108](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/game/teams.ts#L90-L108)); timing change and rationale ([commit `b557e9d`](https://github.com/GabeHirakawa/s2s-ttt-port/commit/b557e9d61f91a1ecfb1a99590756df59ef30383a)). |
| The old ragdoll spawn path produced staging assertions/half-initialized entities | Proven defect; causal share uncertain | High / Medium | Live observations and fixed create → clear staging bit → set model → spawn path ([`bodies.ts` L129-L174](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/cs2/bodies.ts#L129-L174), [commit `28c2b83`](https://github.com/GabeHirakawa/s2s-ttt-port/commit/28c2b83243c776a92855567a5833192877552573)). |
| Re-entrant notify dispatches used to disappear; current queue replays them PRE | Proven | High | [PR #71](https://github.com/s2script/s2script/pull/71); queue is bounded at 256, double-buffered, and drained at the top of PRE ([`defer_queue.cpp` L11-L27, L86-L170](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/shim/src/defer_queue.cpp#L11-L27)). |
| Pre-hooks cannot be replayed later | Proven contract | High | `Delivery` explicitly excludes synchronous-result hooks ([`dispatch.rs` L127-L148](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs#L127-L148)). |
| Plugin-originated engine calls have a nested JS path | Mechanism proven; safety gaps remain | High | [PR #108](https://github.com/s2script/s2script/pull/108) introduced `NestGuard`/`CallbackScope`; current source contains an ineffective depth cap, a private-layout token scan, one unwrapped kick path, and divergent acquire behavior ([`nest.rs` L17-L75](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/nest.rs#L17-L75)). |
| EntityRef rejects stale/recycled handles across maps | Proven on current main | High | Entity books key index to host id + engine serial and serial-check deletes ([`entity_live.rs` L1-L73](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/entity_live.rs#L1-L73)); map clear occurs before JS ([`ffi.rs` L180-L202](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/ffi.rs#L180-L202)). |
| Event objects cannot survive a synchronous handler | Proven contract | High | Published SDK says fields must be read before `await` ([`events.d.ts` L1-L30](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/packages/sdk/events.d.ts#L1-L30)); deferred events duplicate/free the native event ([`events.rs` L389-L417](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/events.rs#L389-L417)). TTT reads event fields synchronously. |
| Current scoped-recipient implementation clears its filter too soon | Proven code regression; effect backed by first-party live record | High | Current code clears at once while adjacent comment says this failed ([`s2script_mm.cpp` L5415-L5455](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/shim/src/s2script_mm.cpp#L5415-L5455)); [PR #46](https://github.com/s2script/s2script/pull/46) records the live-gated intended behavior. |
| TTT source and lockfile use incompatible SDK surfaces | Proven | High | Lock pins 0.11.0/0.11.1 ([`package-lock.json` L619-L654](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/package-lock.json#L619-L654)); published [`sdk-0.11.0.tgz`](https://registry.npmjs.org/@s2script/sdk/-/sdk-0.11.0.tgz) lacks frame `phase` and `Events.setRecipients`, while source uses explicit POST ([`plugin.ts` L461-L478](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/plugin.ts#L461-L478)). |
| Nested `onCanAcquire` votes are discarded | Proven current-main defect | High | Nested fan-out omits `AFTER_HANDLER`; the host path invokes it ([`dispatch.rs` L17-L36, L211-L284, L390-L394](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs#L17-L36)). Acquire folding depends on that callback and empty votes fold to `Allowed` ([`v8host.rs` L4042-L4080](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/v8host.rs#L4042-L4080), [`acquire.rs` L36-L64](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/acquire.rs#L36-L64)). |
| The nesting cap does not cap nesting | Proven current-main defect | High | A refused ninth push leaves eight entries, `with_outbound` still calls the engine, and `top()` returns token eight ([`nest.rs` L17-L75](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/nest.rs#L17-L75)); nested dispatch continues through it ([`dispatch.rs` L191-L208, L309-L313](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs#L191-L208)). |
| `Client.kick` omits outbound nesting | Proven current-main timing defect | High | The kick op is called directly ([`client.rs` L196-L205](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/client.rs#L196-L205)), unlike adjacent command ops; a busy notify dispatch becomes `Deferred` ([`dispatch.rs` L397-L400](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs#L397-L400)). |
| Nesting depends on a private rusty_v8 struct layout | Proven implementation risk | High | `info_ptr` scans a non-`repr(C)` value and treats its first non-null word as `FunctionCallbackInfo` ([`nest.rs` L25-L36](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/nest.rs#L25-L36)); that pointer reaches unsafe `CallbackScope::new` ([`dispatch.rs` L191-L208](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs#L191-L208)). |
| Synchronous role visuals run before the role commit | Proven TTT defect | High | `rotateRoles` clears roles, `assignRoles` emits, then commits with `setRole` ([`roles.ts` L88-L160](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/game/roles.ts#L88-L160)); the MONITOR listener calls `applyRoleVisuals` inline, whose first check requires the uncommitted role ([`icons.ts` L591-L605, L833-L887](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/cs2/icons.ts#L591-L605)). |
| Parallel packing/alternate baselines cause the fatal | Operational hypothesis, not established by available primary source | Low-medium | TTT asserts three mitigation cvars and explains the hypothesis ([`plugin.ts` L172-L187](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/plugin.ts#L172-L187)); no Valve source, packet trace, or controlled result table was found. |

## Detailed findings

### Critical — POST async scheduling still reaches entity lifecycle code

Confidence: high that the scheduling occurs; medium that it causes the remaining fatal.

`nextPreFrame` correctly swaps the queue before running it, catches each callback, clears on map
start/unload, and is drained first from the default-PRE frame subscription
([`preframe.ts`](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/core/preframe.ts#L1-L72)).
However, it is not the only deferred path:

- countdown `delay` → `beginRound()`;
- round deadline `delay` → `endGame()`;
- inter-round `delay` → `GameRules.terminateRound()`;
- finished watchdog `delay` → `returnToWaiting()`;
- glow `after` → `parkGlow()`/`Transmit.setVisibleTo`.

`beginRound` can respawn, clear bodies, assign roles, switch every team, create icons/glows, strip
inventory, and enqueue more entity work. `endGame` switches teams, strips weapons, and emits
`Finished`, whose listeners kill/reset effects. When their guard passes immediately, both start
inside `frame_async_drain`, after simulation and before the outgoing snapshot.

The required migration pattern is:

```ts
void delay(ms).then(() => {
  nextPreFrame(() => {
    if (token !== epoch || state !== expected) return;
    transition();
  });
});
```

The timer should wake bookkeeping in POST and enqueue world mutation for the next PRE. The extra
frame is intentional. Apply the same rule to the glow timeout.

This is also the canonical TTT pattern, not merely a new port convention. Its generic scheduler
callbacks wrap engine mutation in `Server.NextWorldUpdate`, including round timeout, AFK moves,
stations, tripwires, poison effects, and special-round clocks. The port removed that second hop when
it collapsed many schedulers into s2script timers.

Framework improvement: add an owner-ledgered `Server.nextWorldUpdate(fn)` (or
`Timers.after(ms, fn, { phase: "pre" })`) rather than requiring each plugin to build a queue. Its
contract should specify map-epoch cancellation, double buffering, cancellation, exception
containment, a queue/work budget, and whether work scheduled while draining runs this frame or next.
CounterStrikeSharp’s queue drains no more than 1024 entries per `PreWorldUpdate`; it is not a
fixed-capacity queue.

### Critical — dependency/runtime capability skew makes the safety contract unreproducible

Confidence: high.

The source calls `ctx.server.onGameFrame(..., { phase: "post" })`, but the exact published
`@s2script/sdk@0.11.0` declaration accepts only `{ priority }`. That package also lacks
`Events.setRecipients`; TTT works around the missing type by casting `Events` to an optional shape
([`combat.ts` L508-L525](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/cs2/combat.ts#L508-L525)).
The code therefore cannot be faithfully rebuilt against its lockfile, and runtime behavior depends
on an unrecorded separately installed core/shim.

Do not merely widen the semver range. Pin and test one compatible tuple:

- exact SDK package;
- exact game package;
- exact core/shim release or commit;
- gamedata version/build id.

s2script should embed a runtime ABI/capability manifest in `.s2sp` artifacts and reject load when a
required capability (`frame.phase`, `events.scopedRecipients`, `nest.outbound`, entity liveness
generation) is absent. The CLI should also fail when source imports an API newer than the declared
minimum runtime. TTT should remove optional casts once it requires the matching release.

### Critical — scoped event-recipient filtering is internally contradictory on current main

Confidence: high.

The current shim does this:

1. take the one-shot mask;
2. set `s_legacyFilterActive`;
3. call `FireEvent`;
4. immediately clear active/mask.

Lines immediately after the clear say the immediate-clear implementation “never fired once”
because client-bound messages are batched, and claim `Hook_GameFramePost` performs the clear.
`Hook_GameFramePost` only dispatches the frame hook. This is a concrete code/comment regression from
the live-gated behavior described in [PR #46](https://github.com/s2script/s2script/pull/46).

Simply moving the clear to frame POST is not a complete design: two suppressed events in one frame
can overwrite one frame-global mask, and nested events can consume the wrong one. The filter must be
correlated to the actual legacy-game-event post, e.g. by an event sequence/token or a FIFO of
pending `(event identity, allow mask)` records. Required tests:

- post occurs after `FireEvent` returns;
- two differently scoped events in one frame;
- nested `Events.fire`;
- a pre-handler throws after setting a mask;
- `Handled` with no mask;
- map change/unload while a post is pending.

This defect leaks kill-feed information; it is not itself a `CopyExistingEntity` cause.

### Critical — nested acquisition handlers run, but their result is discarded

Confidence: high.

The isolate-reentry work makes plugin-originated engine calls visible to synchronous hooks in other
plugins. Acquisition is not a normal max-`HookResult` collapse, though: it records each handler's
written result and whether it requested `Handled`/`Stop`, orders those votes, and combines them with
the engine result.

That recording is installed through `AFTER_HANDLER`. The host-borrow fan-out invokes it after every
subscriber; the nested `CallbackScope` fan-out does not. `dispatch_hook` therefore creates an
acquire session, runs the handlers, receives a collapsed `HookResult`, then finds zero votes and
writes `Allowed`/`not voted` back to the native view. A `giveNamedItem`-triggered handler can log
that it denied an item while the engine still grants it.

Fix this in the shared subscriber walk so host and nested paths report the same per-handler result.
Add an in-isolate regression where nested `Engine.call` reaches `onCanAcquire`, a handler returns
`Handled` without writing `result`, and the implicit `InvalidItem` denial reaches the engine. The
existing reentry gate only proves that a `Continue` handler ran, so it cannot catch this defect.

### Critical — TTT's internal “monitor” phase is still pre-commit

Confidence: high.

The port's bus sorts handlers by priority, but has no transaction boundary between validators and
observers. `assignRoles` emits `roleAssign`, waits for the whole list, and only then calls
`reg.setRole`. The latest timing commit made icon creation synchronous inside a MONITOR handler,
but `applyRoleVisuals` immediately returns unless `reg.roleOf(slot) === role`. `rotateRoles` cleared
the registry immediately before the deal, so that condition is false for every ordinary assignment.

Deleting the guard alone is unsafe. It makes icons run, but because `beginRound` was awakened by a
POST `delay`, it also restores the team-switch plus filtered-entity creation window under
investigation.

Split this transition into:

1. `roleAssigning` — rewrite/cancel, with no external side effects;
2. commit the role and team intent;
3. `roleAssigned` — observer/side-effect phase, scheduled PRE when it mutates entities.

Apply the same rule to `gameState`: MONITOR means “later in this dispatch,” not “after state
commit.” If cancellation remains supported, no side-effecting observer should run before the
transition is known to commit.

### High — plugin unload removes transmit ownership before world-entity cleanup

Confidence: high for ordering; medium for client-fatal consequence.

Current s2script unload first sweeps all owner stores, including transmit rules, then invokes the
plugin’s `onUnload`
([`v8host.rs` L6642-L6676](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/v8host.rs#L6642-L6676)).
TTT’s unload hook destroys bodies/effects/icons afterward
([`plugin.ts` L521-L540](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/plugin.ts#L521-L540)).
Yet its own entity-removal comments require hidden entities to stay filtered while `Kill` is queued.

Thus a hot reload can make previously hidden, still-live entities visible before their queued
teardown is serviced. It also creates a visibility/create/delete burst during the riskiest lifecycle
window.

Framework options:

1. mark the plugin Unloading and disable inbound callbacks, run `onUnload` while declarative
   outbound state remains, then sweep transmit/voice state; or
2. ledger game-world entities with an owner cleanup policy and perform safe entity cleanup before
   visibility rules are removed.

This ordering needs an integration test with a hidden entity, a client excluded from its create,
and a hot reload.

### High — synchronous pre-hooks remain a fail-open re-entrancy boundary

Confidence: high.

The deferred queue solves notify-only delivery. A pre-hook’s result is consumed synchronously, so a
true engine-originated callback that re-enters while `HOST` is busy cannot be answered next frame.
It is skipped/fails open by design. `NestGuard` closes the common plugin-originated path for engine
calls such as create/spawn/remove, `acceptInput`, `Events.fire`, `slay`, and commands, but only while
a valid V8 callback token is published.

The nominal depth-eight guard is not an effective recursion cap. Once eight tokens exist, a ninth
push is refused but the engine call still runs and `nest::top()` still returns token eight. Deeper
dispatches continue through a live but non-innermost callback frame. Either refuse/degrade the
outbound engine call on overflow, or publish a suppression sentinel that makes nested fan-out use
the documented busy-host fail-open path. A depth-nine test must assert both the engine-call policy
and which callback token is used.

Token extraction is also version-fragile: it scans the object representation of
`FunctionCallbackArguments`, whose layout is private and not `repr(C)`. Replace it with a supported
rusty_v8 accessor/binding. If none exists at the pinned version, isolate the unsafe dependency behind
an exact-version layout gate and startup self-test. A wrong non-null pointer reaches
`CallbackScope::new`, so this is a process-crash boundary, not merely API compatibility.

Finally, outbound nesting is hand-applied per native. `Client.kick` demonstrably omits it, making
disconnect observers one frame late. Generate or centralize wrappers for every mutating
`S2EngineOps` call and explicitly classify any intentionally non-nesting operation.

TTT’s gadget slay deferral remains defensible as a compatibility path, but the comments should be
versioned: on a runtime including [PR #108](https://github.com/s2script/s2script/pull/108),
plugin-originated `slay()` is expected to nest synchronously. A runtime counter/log should expose
every skipped pre-hook, with hook name and same-hook/MAX_NEST reason; silent fail-open must not be
treated as successful suppression.

Pre-hook callback types should reject `Promise` returns, and documentation/lint should require all
native event fields be copied to plain JS data before any deferred work.

### High — the team and purchase workarounds should move to true engine gates

Confidence: high.

TTT reacts to `player_team` after the engine has already changed team, then switches the player back.
That adds pawn teardown/respawn churn and relies on assumptions about whether the corrective switch
redispatches the same event. Current s2script exposes `ctx.commands.onClientCommand`; intercept
`jointeam` and return `Handled`, matching the C# design and preventing the first mutation.

Likewise `item_purchase` is already post-grant semantically even though TTT observes `FireEvent` in
PRE mode. The plugin removes the newly created weapon while inside event dispatch and then performs
its own shop grant. Current s2script’s CS2 package has `ctx.items.onCanAcquire` (merged with
[PR #108](https://github.com/s2script/s2script/pull/108)); refuse or redirect at acquisition time
where possible. This removes a create-then-remove cycle and the need to reason about nested event
dispatch during the purchase event.

### High — TTT’s manual PRE queue has no capacity, ownership, or client-generation guard

Confidence: high for design gap; low for observed exploitation.

The queue is double-buffered and exception-contained, which prevents self-requeue frame loops.
It is unbounded, has no per-frame work budget, no cancel handle, and no owner/map/round token built
into the abstraction. Map start and unload clear it globally, but many callbacks capture a slot and
only re-check role. A disconnect/reconnect in the same slot with the same role can receive a stale
weapon or action. Inventory callbacks do not re-check identity at all
([`inventory.ts` L267-L319](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/cs2/inventory.ts#L267-L319)).

Until the framework owns this:

- cap queued and drained work, logging newest drops;
- stamp callbacks with map epoch + round epoch;
- for slot work, capture SteamID/userID or a registry connection generation and compare on run;
- return a cancel handle;
- expose queue depth/high-water/drop counters.

### Medium-high — direct `EntityRef.remove()` contradicts the plugin’s teardown rule

Confidence: high for inconsistency; medium for risk.

Almost every plugin-owned network entity is removed via `acceptInput("Kill")` because the repository
states direct removal can make an index immediately reusable. Buy zones are the exception:
`removeBuyZones` invokes `.remove()` directly
([`handlers.ts` L85-L101](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/cs2/handlers.ts#L85-L101)).
This is map-start/round-start work rather than high-frequency churn, but it should follow one
documented lifecycle policy. Prefer `Kill` in PRE, or have the framework expose a clearly named
safe queued destroy distinct from immediate `UTIL_Remove`.

### Medium — entity liveness is strong, but raw indices remain weaker identities

Confidence: high.

Current `EntityRef` is fail-closed: every operation revalidates host id and engine serial, map start
clears the books, and deferred delete replay intentionally receives a null ref. TTT generally keeps
the ref and checks `isValid()`.

Residual weak spots are maps keyed only by entity index (`byIndex`, smoke `entityid`) and cached body
records that can remain after an engine-side purge. Any lookup by index must validate the stored
`EntityRef` before acting and evict a mismatch. Framework APIs should prefer packed handles or
`EntityRef` over bare indices in event adapters wherever the engine provides a handle.

### Medium — exception containment is good at the framework boundary but partial inside TTT

Confidence: high.

s2script snapshots handler lists, checks plugin generation, enters each plugin context, and wraps
each handler in `TryCatch`
([`dispatch.rs` L39-L69, L211-L284](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs#L39-L69)).
Timer callbacks are also contained. Rust FFI entries use `catch_unwind`.

TTT’s internal `EventBus.emit` iterates the live array and calls handlers without a try/catch
([`bus.ts` L58-L88](https://github.com/GabeHirakawa/s2s-ttt-port/blob/b557e9d61f91a1ecfb1a99590756df59ef30383a/src/core/bus.ts#L58-L88)).
One exception aborts all later consequences after earlier handlers may already have changed teams,
entities, balances, or counters. `onDeathPre` specially catches `handleDeath`, but other critical
round/role transitions do not. Subscribing during emit can also mutate the array being traversed.

Snapshot the bus list before dispatch, define whether new subscriptions apply to the next event,
and isolate/log each handler. For transactional transitions, separate validation/planning from world
mutation or add compensating cleanup.

### Medium — detours are safer, not self-proving

Confidence: high.

[PR #79](https://github.com/s2script/s2script/pull/79) added near/far detours, instruction
relocation, executable-range probing, and tests. Its live gate also found a 64-bit engine pointer
mistyped as 32-bit; the first call truncated the pointer and later crashed elsewhere. This is direct
evidence that hook shape/ABI correctness cannot be inferred from successful installation.

Keep per-build live gates for every detour and preserve unknown inbound arguments at full register
width. On full framework unload, unresolved `RemoveListenerEntity` currently leaves a dangling
engine listener and only warns that the next entity lifecycle callback may jump into unmapped code
([`s2script_mm.cpp` L5296-L5310](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/shim/src/s2script_mm.cpp#L5296-L5310)).
The safe policy is to refuse hot-unload (or keep the module nodelete/resident), not continue after a
known dangling callback.

### Hypothesis — parallel packing and alternate baselines amplify transmit/index churn

Confidence: low-medium.

TTT forcibly disables:

```text
sv_parallel_packentities
sv_parallel_sendsnapshot
sv_enable_alternate_baselines
```

The plugin states worker packing races mutable per-client transmit bit vectors and that alternate
baselines key by index without serial. No Valve source, official generated API, packet trace, or
controlled A/B crash table was found to validate those internals. Current s2script’s transmit table
is an unsynchronized `unordered_map`, while `Hook_CheckTransmit` serial-validates each entry and
only filters fully signed-on clients
([`s2script_mm.cpp` L5796-L5865](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/shim/src/s2script_mm.cpp#L5796-L5865)).
Whether the hook can race framework writes depends on engine threading not established here.

Keep the cvars as conservative operational mitigations until measured otherwise, but label them
unproven. s2script should either prove CheckTransmit and transmit-rule writes are main-thread
serialized or publish immutable/copy-on-write rule snapshots to the hot path.

## Exact triggering sequences reconstructed

### Sequence A: released pawn index → delayed filtered glow

Status: best-supported timing reconstruction, not packet-level proof.

1. Roles are dealt after countdown.
2. The old team optimization switched only the Detective, and `switchTeam` could replace/respawn
   that pawn.
3. The old implementation delayed both icon/glow creation with `nextFrame`, whose continuation runs
   in POST.
4. The released pawn index became allocator-visible, and a transmit-filtered glow could claim it
   after simulation but before a client had observed the old pawn’s deletion.
5. A non-Traitor, from whom the replacement glow was filtered, had no valid replacement record for
   the index; a later delta failed with `CopyExistingEntity`.

Evidence: Detective-heavy live reports and late-join Detective reproduction in `teams.ts`; the
timing diagnosis and changes in `b557e9d`. Missing evidence: the same index’s serial/occupant from
release through client packet.

### Sequence B: staged ragdoll → half-initialized skeletal network entity

Status: initialization defect proven; direct attribution to each client fatal not proven.

1. `prop_ragdoll` is created in the staging list.
2. Calling `setModel` before clearing `EF_IN_STAGING_LIST` asserts in `SetupModel`; spawning first
   creates a model-less/broken entity.
3. The malformed skeletal entity reaches networking and clients fail to construct/copy it.
4. The fixed path clears the staging bit, sets the model, then dispatches spawn, mirroring the
   reference body spawner.

Evidence: live staging assertion and server crash observations, `bodies off = no crash`, and commit
`28c2b83`. The commit itself says its final fix was not live-tested before landing.

### Sequence C: hidden entity/sign-on or parallel snapshot inconsistency

Status: hypothesis.

1. CheckTransmit removes a create/update from one client.
2. During sign-on, parallel pack, visibility-rule update, or rapid index reuse, the client receives
   a later delta/baseline that assumes the entity exists.
3. The client lacks the entity record and fails.

PR [#85](https://github.com/s2script/s2script/pull/85) closed one real divergence by filtering only
fully signed-on clients but explicitly called it a weak fit and reported no live exercise. TTT’s
cvars and DNA-glow default-off policy remain sensible mitigations, not causal proof.

## Recommended change order

### TTT

1. Pin a compatible current SDK/CS2/runtime tuple; make the build and deployment record it.
2. Split role assignment/state transitions into validate, commit, and post-commit events.
3. Wrap every entity-affecting `delay`/`after` continuation in `nextPreFrame`.
4. Add map/round/client-generation tokens and bounds/metrics to the manual PRE queue.
5. Intercept `jointeam` before mutation; move purchase rejection to `onCanAcquire` after its nested
   vote bug is fixed.
6. Replace direct buy-zone `remove()` with the documented safe destroy path.
7. Make the internal event bus snapshot and contain each handler.
8. Validate stored refs whenever resolving a body/effect by raw entity index.
9. Keep DNA glow off and the three snapshot cvars conservative until a controlled stress gate
   disproves their need.

### s2script

1. Make nested and host fan-out run identical per-handler acquisition folding.
2. Fix scoped-recipient correlation and add batched/nested-event tests.
3. Make the recursion cap real and replace the private-layout callback-info scan.
4. Centralize outbound nesting; include `Client.kick` and audit every mutating engine op.
5. Ship an owner-ledgered PRE/world-update scheduling API; make timer continuation phase explicit in
   docs and types.
6. Add debug assertions/telemetry for networked create/spawn/remove/reparent/teleport/transmit writes
   from POST.
7. Give event pre-hooks real priority options or remove the `Stop` contract that promises
   lower-priority truncation the subscription API cannot express.
8. Enforce package/runtime capability compatibility at build and load.
9. Count and identify fail-open pre-hook skips.
10. Preserve transmit state through plugin cleanup or ledger game-world entities.
11. Prove transmit-table thread serialization or use immutable snapshots.
12. Refuse unsafe full unload when an engine listener/detour cannot be removed.

### Stress and regression gate

Run at least two real clients (not only bots), record entity index + serial + class and snapshot
phase, and cover:

- late joiner repeatedly dealt Detective;
- high-rate corpse create/settle/kill;
- role icon and DNA relay parent/child churn;
- disconnect/reconnect into the same slot between queued callbacks;
- map change and hot reload with hidden entities alive;
- nested gadget kill and purchase/team callbacks;
- scoped deaths twice in one frame with different viewer masks;
- matrix of the three snapshot/baseline cvars.

The success criterion is not only “no server crash”: no client fatal, no missing create/delete
sequence in packet/entity traces, no pre-hook skip, no deferred-queue overflow, and no stale
generation callback.

## Explicit unknowns

- No Valve source or official documentation for the client’s `CopyExistingEntity` implementation
  was found.
- No packet capture ties one fatal index to its old/new serial and per-client create/delete history.
- The deployed s2script core/shim version used for the live incidents is unknown.
- The final `b557e9d` and `28c2b83` commit messages both disclose incomplete live verification.
- No reviewed live gate proves nested `onCanAcquire` denial; the reentry fixture only observes a
  `Continue` handler, and the merge PR reports no live CS2 gate.
- It is unknown whether all `CheckTransmit` calls and transmit-rule writes are main-thread
  serialized when parallel packing is enabled.
- The claim that alternate baselines are index-keyed without a serial check was not independently
  verified from Valve source.
- The exact engine guarantee of `AcceptInput("Kill")` versus `UTIL_Remove` relative to snapshot
  deletion/index reuse is inferred from reference behavior and live observations, not an official
  contract.
- Multiple defects existed concurrently, so crash-rate improvements do not isolate one cause.

## Primary-source index

- TTT timing fix: [`b557e9d`](https://github.com/GabeHirakawa/s2s-ttt-port/commit/b557e9d61f91a1ecfb1a99590756df59ef30383a)
- TTT ragdoll fix: [`28c2b83`](https://github.com/GabeHirakawa/s2s-ttt-port/commit/28c2b83243c776a92855567a5833192877552573)
- Canonical TTT scheduling/entity order:
  [`RoundTimerListener.cs`](https://github.com/edgegamers/TTT/blob/80716fba705a42ea60bfae0095b5a222e9eba7d1/TTT/CS2/Listeners/RoundTimerListener.cs),
  [`BodySpawner.cs`](https://github.com/edgegamers/TTT/blob/80716fba705a42ea60bfae0095b5a222e9eba7d1/TTT/CS2/GameHandlers/BodySpawner.cs),
  [`RoleIconsHandler.cs`](https://github.com/edgegamers/TTT/blob/80716fba705a42ea60bfae0095b5a222e9eba7d1/TTT/CS2/GameHandlers/RoleIconsHandler.cs)
- s2script true frame phase/scoped recipients/client commands:
  [PR #46](https://github.com/s2script/s2script/pull/46)
- s2script deferred notify queue:
  [PR #71](https://github.com/s2script/s2script/pull/71),
  [`defer_queue.cpp`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/shim/src/defer_queue.cpp)
- s2script detour relocation and ABI live gate:
  [PR #79](https://github.com/s2script/s2script/pull/79)
- s2script signed-on transmit filtering/entity trace:
  [PR #85](https://github.com/s2script/s2script/pull/85)
- s2script nested plugin engine calls:
  [PR #108](https://github.com/s2script/s2script/pull/108),
  [merge PR #110](https://github.com/s2script/s2script/pull/110),
  [`nest.rs`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/nest.rs)
- s2script dispatch/event/lifecycle source:
  [`dispatch.rs`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/dispatch.rs),
  [`events.rs`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/events.rs),
  [`entity_live.rs`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/entity_live.rs),
  [`v8host.rs`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/v8host.rs),
  [`s2script_mm.cpp`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/shim/src/s2script_mm.cpp)
- CounterStrikeSharp world-update queue:
  [`Server.cs`](https://github.com/roflmuffin/CounterStrikeSharp/blob/55542dba7c5318dfbb37b0862256f4dcde7cf0f4/managed/CounterStrikeSharp.API/Server.cs),
  [`server_manager.cpp`](https://github.com/roflmuffin/CounterStrikeSharp/blob/55542dba7c5318dfbb37b0862256f4dcde7cf0f4/src/core/managers/server_manager.cpp)
