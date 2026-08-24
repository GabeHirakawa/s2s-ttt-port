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

## Other host defects (not the hot-reload fatal)

Recorded in `research/event-hook-timing-audit.md` if that document is present; otherwise the
2026-08-23 audit on `cursor/research-event-hook-timing-3347`:

- Nested `onCanAcquire` fan-out omits `AFTER_HANDLER`, so denials fold to Allowed.
- `MAX_NEST` refuses a ninth token push but still nests through token eight.
- `Client.kick` is not wrapped in outbound nesting.
- Nest token scan depends on a private rusty_v8 layout.
- Scoped-recipient immediate-clear vs POST-clear comments disagree; re-live-gate.
- No owner-ledgered `Server.nextWorldUpdate`.

## Plugin runtime pin

TTT source typechecks against published `@s2script/sdk@0.11.0` plus
`src/s2script-runtime.d.ts` (`s2s build` only loads top-level `src/*.d.ts`).
Deploy the host at or after `a835e6c77d2b648392d53686f919738193dbe10b`.
