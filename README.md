# TTT — Trouble in Terrorist Town

An s2script port of [edgegamers/TTT](https://github.com/edgegamers/TTT) (CounterStrikeSharp, C#).

**Requires s2script runtime >= 0.4.0** (`@s2script/sdk` 0.10.x, `@s2script/cs2` 0.8.x). Earlier
runtimes cannot resolve `EntityRef.setModel`, which corpses depend on — see below.

A round of TTT hands out hidden roles: a few **Traitors**, one or two **Detectives**, and the rest
**Innocents**. Deaths are hidden — a dead player keeps reading as alive until someone finds their
corpse and identifies it. Traitors win by killing everyone else; the innocent side wins by killing
every Traitor.

```
!ttt          version            !shop            list the shop
!ttt status   round diagnostics  !buy <item>      buy something
!logs         round action log   !balance         your credits
!karma        your karma         @<message>       Traitor-only chat
```

`ttt status` prints the round state, per-player role/liveness/credits/karma and the warmup flag. It
is the only view into the mode from an rcon console, since everything else TTT says goes to chat.

Admin (`ADMFLAG_GENERIC`): `ttt_start`, `ttt_end`, `ttt_special [id]`, `ttt_setrole <slot> <role>`.

## Layout

| module     | ports                                                          |
| ---------- | -------------------------------------------------------------- |
| `core/`    | `TTT.API`, `TTT.Game.EventBus`, `TTT.Locale`, the config layer  |
| `game/`    | `RoundBasedGame`, `RoleAssigner`, `SimpleLogger`                |
| `cs2/`     | `TTT.CS2` — pawns, corpses, combat, USE interactions            |
| `karma/`   | `TTT.Karma`                                                     |
| `shop/`    | `ShopAPI` + `TTT.Shop` + every item under `CS2/Items`           |
| `special/` | `SpecialRoundAPI` + `TTT.SpecialRound`                          |

## Configuration

Every `css_ttt_*` ConVar from the C# build is registered here under the same name with the same
default and range, so an existing `ttt.cfg` carries over unchanged. `s2s config gen` will emit the
full list; `src/core/cvars.ts` is the source of truth.

Message text can be overridden with a flat JSON file in the configs directory, named via the
`phrases_file` manifest option. It uses the same syntax as the original's `en.yml`: `%KEY%` splices,
`{color}` tokens, `{0}` arguments, `%s%` pluralization and `%an%`.

## What changed, and why

The C# build leans on dependency injection, reflection and `Task` for control flow that is neither
async nor dynamic. Four changes account for nearly all of the difference in per-frame cost.

**One frame handler.** The original registered an `OnTick` listener plus separate `AddTimer` /
`SchedulePeriodic` subscriptions across `PropMover`, `NameDisplayer`, `CS2AliveSpoofer`,
`PeriodicRewarder`, `RoundTimerListener` and each station/tripwire item. Everything periodic here
runs from the single `ctx.server.onGameFrame` in `plugin.ts`, with each subsystem gating on its own
accumulator.

**Slot-indexed state.** Roles, karma, balances, alive flags and item charges are entries in fixed
64-wide typed arrays indexed by engine slot, not `Dictionary<string, T>` keyed by a SteamID *string*.
`GetRoles(player).Any(r => r is TraitorRole)` — a string hash, a dictionary probe, a collection
allocation and N runtime type tests — becomes one array load and an integer compare. The same idea
retires the karma first-blood tracker's `List<(string,string)>.Contains` linear scan in favour of a
bitmatrix, and `PeriodicRewarder`'s per-player `List<Vector>` (trimmed with an O(n)
`RemoveAt(0)`) in favour of one shared ring buffer with incrementally accumulated distance.

**Config is a snapshot.** Every C# config property getter resolved an `IStorage<T>` out of the DI
container, allocated a fresh record and blocked on a `Task` — per read, from inside per-tick
handlers. ConVars here are parsed once into a plain object and refreshed at round boundaries.

**O(1) win checks and a reflection-free bus.** `getWinningTeam` walked every player with a role
lookup and type test on every death, disconnect and 1 Hz safety tick; the registry now keeps live
per-role alive counters, so the check is three integer reads. The event bus keeps the original's
priority/cancellation contract but sorts handlers once at subscribe time and dispatches through a
plain loop instead of `MethodInfo.Invoke` with a boxed `object[]` per call. Phrases compile once at
load into chunk lists rather than running four regexes and N dictionary lookups per message.

## Where this improves on the original

**Dead players get their own voice channel.** The C# `PlayerMuter` set `VoiceFlags.Muted`, silencing
dead players outright. Using `Voice.setAudibleTo` (runtime 0.4.0) TTT expresses the rule it actually
wants — a dead player is audible only to other dead players — so death chat works without leaking
anything to players still in the round. Rules are declarative and only rewritten when the dead set
changes.

## Server settings TTT enforces

TTT applies these itself, at load, on map start **and** on round start — the map's own
`gamemode_*.cfg` execs after `onMapStart` and would otherwise overwrite them:

```
mp_ignore_round_win_conditions 1   # TTT decides its own round outcomes
mp_teammates_are_enemies 1         # everyone can hurt everyone
mp_friendlyfire 1
mp_do_warmup_period 0              # warmup blocks round start outright
mp_warmuptime 0
```

Because TTT tells the engine to ignore win conditions, the engine never restarts a round on its
own. TTT therefore **self-starts**: it polls its own WAITING state rather than waiting for a
`round_start` that may never come.

## Runtime gap: the damage pre-hook

**On runtime v0.4.0 `ctx.entities.onDamage` never receives real combat damage** — only the synthetic
`S2_DAMAGE_SELFTEST` injection. Verified independently: over a full session of bots shooting each
other, both TTT and the first-party `basecommands` plugin saw exactly three damage callbacks, at
frames 300/900/1800 (the self-test frames), and there is no `TakeDamage` entry in the runtime's
gamedata at all.

Two consequences, both worked around:

- **Out-of-round protection** does not go through the damage hook. TTT keeps
  `mp_teammates_are_enemies 1` / `mp_friendlyfire 1` on permanently, so without protection players
  shoot each other dead during WAITING and the countdown and are then not alive to be dealt a role.
  Instead of cancelling damage, TTT clears `m_bTakesDamage` on every pawn outside a live round —
  enforced by the engine, no hook needed. (`OutOfRoundCanceler` is still ported and will take over
  if the hook starts working.)
- **Damage-driven shop items** (Taser, One-Shot Revolver, One-Hit Knife, Poison Shots, Tripwire
  friendly-fire scaling) run off a `player_hurt` fallback instead. That event is POST-damage, so
  `onPlayerHurt` reconstructs the same `damage` event and repairs the result: a cancel restores the
  health the hit took, a rescale applies the difference. Two honest caveats — the victim sees a
  momentary health dip, and a hit that already took them to 0 cannot be undone. The fallback
  self-disables the moment the real pre-hook delivers anything, so nothing is processed twice.

`ttt status` reports `damage: preHook=N fallback=N` so you can see which path is live.

## Known differences from the original

These are places where the s2script API does not expose what the C# reached for. Each is called out
at its own module too.

- **Camouflage does not dim the model.** The C# lowered the pawn's render alpha via `SetColor`.
  `m_clrRender` is not in the s2script schema, and the one available visibility primitive
  (`Transmit.setVisibleTo`) is all-or-nothing per viewer — using it would grant full invisibility, a
  meaningfully stronger item. Camouflage here only suppresses the name-display reveal.
- **Corpses use the stock team model.** The original copied the victim's own model off the pawn's
  skeleton instance; that path is not exposed. Players wearing non-default agents get a generic
  corpse. Body identification falls back to proximity if the model fails to load at all, so it keeps
  working either way.
- **Corpse collision is engine-default.** The C# set the collision group to `DEBRIS`. That field is
  not reachable, so bodies stay solid to traces (which is what makes identification work).
- **Corpses require runtime >= 0.4.0, and a specific spawn order.** A `prop_ragdoll` must have its
  model set *before* `DispatchSpawn` — spawn it without one and the engine tears it down a moment
  later (it reads as created, then goes invalid). Passing `model` as a spawn keyvalue is not
  equivalent. `spawnBody` therefore does create -> `setModel` -> `spawn`, which needs
  `EntityRef.setModel`; that signature only resolves from runtime v0.4.0 (`gamedata FAIL SetModel`
  on v0.3.0).
- **Cluster Grenade fragments are damage, not projectiles.** The C# built real
  `CHEGrenadeProjectile`s through a CounterStrikeSharp helper. There is no equivalent projectile
  construction path, so the fragments land as a ring of blasts at the same reach and lethality,
  without grenades visibly bouncing outward.
- **The Pistol round strips rifles instead of refusing them.** The C# hooked
  `CCSPlayer_ItemServices::CanAcquire`. Without vfunc hooking, a picked-up rifle is removed on the
  next tick and rifle damage is nullified — same outcome, one frame later.
- **Per-round match-stat suppression is gone.** `CombatHandler` decremented
  `ActionTrackingServices.MatchStats` to hide kills/deaths from the scoreboard;
  `m_pActionTrackingServices` is not in the schema. The scoreboard's kill column will reflect real
  kills. Deaths are still hidden through `pawnIsAlive`, which is what actually matters for the game.
- **The `Stats` and `RTD` modules are not ported.** `Stats` posted round summaries to an external
  HTTP endpoint that is specific to the upstream deployment; `RTD` is an optional side-mode. Neither
  is part of TTT's core loop.
- **Bots are exempt from the AFK sweep.** A bot cannot act on an AFK warning, so on a bot-populated
  server every bot would be benched a minute into the first round and the mode could never start
  another. (The C# had no such exemption, and wrapped its team-change in `#if !DEBUG`.)
- **A hot reload resets the current round.** All state is module-level and the factory re-runs, so
  reloading mid-round drops back to WAITING and starts a fresh round. The SDK's `ctx.previous` /
  `state()` handoff is not used.
- **`@s2script/cs2@0.7.5` ships a broken `Weapon` type.** Its `package.json` `files` list omits
  `weapon.d.ts`, so the published `Weapon` re-export resolves to `any` and gives no checking.
  `src/cs2/inventory.ts` declares a local `HeldWeapon` shape and probes for the class-name property
  at runtime rather than trusting an unverified name.

## Build

```sh
npm install
npm run build     # -> dist/_edgegamers_ttt.s2sp
```

`s2s build` runs the pinned typecheck and lint rules; a green editor means a green build.
