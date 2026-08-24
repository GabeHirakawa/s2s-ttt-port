# s2script companion: unload vs transmit

Date: 2026-08-23

This plugin (`GabeHirakawa/s2s-ttt-port`) now hides every filtered entity, queues `Kill`, and
restores names/voice/cvars inside `onUnload`. That is the most it can do while the host still
sweeps owner stores *before* `onUnload`.

Required host change, against current `unload_plugin` in
[`core/src/v8host.rs`](https://github.com/s2script/s2script/blob/a835e6c77d2b648392d53686f919738193dbe10b/core/src/v8host.rs#L6642-L6676):

## Contract

1. Split `sweep_owner` into **subscriptions** (events, commands, damage, usercmd, chat) versus
   **world filters** (`TRANSMIT`, and `VOICE` only after the plugin has had a chance to unmute).
2. Run `state()` + `onUnload` **before** sweeping `TRANSMIT`.
3. Sweep remaining owner stores **again** after `onUnload`, so hide rules re-applied during teardown
   do not leak onto the next load of the same plugin id.
4. Keep `FRAME` until after `onUnload`, or provide a host-owned one-shot post-unload PRE drain.
   Plugins cannot `nextPreFrame` from `onUnload` today because `FRAME` is already gone.
5. Longer-term: owner-ledgered world entities with “kill-while-filtered, drop the rule when delete
   is observed.”
6. Refuse full Metamod unload when `RemoveListenerEntity` / a live detour cannot be removed.

## Suggested host sequence

```text
mark Unloading
sweep subscriptions (not TRANSMIT)
onUnload                 # plugin re-hides, Kills, restores names
sweep TRANSMIT + leftovers
teardown ledger / dispose context
```

## Remaining host checklist (not in this repo)

Recorded in `research/event-hook-timing-audit.md` if that document is present; otherwise the
2026-08-23 audit on `cursor/research-event-hook-timing-3347`. None of these can land in
`s2s-ttt-port`; they need s2script PRs.

1. Nested `onCanAcquire` fan-out must record `AFTER_HANDLER` so denials do not fold to Allowed.
   TTT keeps the `item_purchase` strip fallback until this lands.
2. Make `MAX_NEST` a real recursion cap (overflow currently reuses token eight and keeps nesting).
3. Wrap `Client.kick` in outbound nesting; audit every mutating `S2EngineOps` call.
4. Replace the private rusty_v8 `FunctionCallbackArguments` layout scan with a supported accessor.
5. Re-live-gate scoped-recipient immediate-clear vs POST-clear; reconcile the contradictory comments.
6. Ship an owner-ledgered `Server.nextWorldUpdate` (PRE/world-update scheduling API).
7. Telemetry/assertions for networked create/spawn/remove/reparent/teleport/transmit writes from POST.
8. Pre-hook priority vs `Stop`, or drop the contract the subscription API cannot express.
9. Count and identify fail-open pre-hook skips (hook name + same-hook / MAX_NEST reason).
10. Preserve transmit through plugin cleanup (this document's contract) or ledger game-world entities.
11. Prove transmit-table thread serialization or publish immutable snapshots to CheckTransmit.
12. Refuse full Metamod unload when `RemoveListenerEntity` / a live detour cannot be removed.

## Plugin runtime pin

TTT typechecks against published `@s2script/sdk@0.21.0` / `@s2script/cs2@0.13.0`.
`ctx.items.onCanAcquire` is still missing from those types; `src/s2script-items.d.ts`
covers it (`s2s build` only loads top-level `src/*.d.ts`). Deploy the host at or after
`a835e6c77d2b648392d53686f919738193dbe10b`.
