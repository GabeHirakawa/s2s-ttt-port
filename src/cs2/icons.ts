/**
 * In-world role markers, role uniforms and the scoreboard role tag — the port of
 * `CS2/GameHandlers/RoleIconsHandler`, `CS2/Hats/TextSpawner` + `CS2/Hats/TextSetting`, and the
 * `PlayerExtensions.SetClan` calls in `BodyPickupListener` / `RoundTimerListener.revealRoles`.
 *
 * Three separate identification channels the original had and this port did not:
 *
 *  1. **A floating letter above the head.** Two `point_worldtext` panels parented to the pawn,
 *     showing the first letter of the role name in the role colour. The Detective's blue "D" is
 *     visible to everyone; a Traitor's red "T" only to the other Traitors. This is how Traitors
 *     recognise each other mid-firefight and how anyone finds the Detective at a glance — without
 *     it a Traitor has only the one-shot buddy list `revealTraitorBuddies` prints at round start.
 *  2. **A role uniform.** Everyone wears the same model (Detective aside), so a silhouette carries
 *     no information about *who* you are looking at — only about their role.
 *  3. **A scoreboard role tag.** "Detective" for the whole round, the real role once a corpse is
 *     identified, and everyone's role at round end.
 *
 * ## The visibility model is transposed, not reimplemented
 *
 * The C# kept a per-VIEWER `ulong[64]` bitmask and stripped entities out of `TransmitEntities` in a
 * `CheckTransmit` listener — JS (well, C#) running per client per snapshot. s2script exposes the
 * same filter declaratively and per-ENTITY: `Transmit.setVisibleTo(icon, viewers)`. That is the
 * exact transpose of the bitmask, and the engine enforces it with nothing of ours in the snapshot
 * path. Two consequences worth knowing:
 *
 *  - *No rule at all* means "visible to everyone", so the Detective icon and a Stickers reveal
 *    install NO rule (`Transmit.reset`) rather than enumerating the connected slots. That matches
 *    the C#, which OR'd the bit into all 64 masks including slots nobody occupied yet — a player
 *    who connects mid-round still sees them.
 *  - A rule that fails to install would leave an icon visible to everyone, which for a Traitor is
 *    worse than having no icon at all. Every restricted icon is therefore FAIL-CLOSED: if the rule
 *    is refused (capability unavailable), the icon is destroyed instead.
 *
 * ## Deliberate deviations
 *
 *  - **Innocent icons are spawned lazily.** The C# spawned an "I" panel for every Innocent and then
 *    put it in nobody's mask — two permanently invisible entities per Innocent, i.e. most of the
 *    server. Here an Innocent only gets panels if something reveals them (Stickers), which is
 *    player-visibly identical and halves the entity count in the common case.
 *  - **`m_szClan` is not in the s2script schema** and there is no `setClan`, so the scoreboard tag
 *    rides `Player.setName` as a `"[D] "` prefix. Unlike the clan column a name prefix is also
 *    visible in the kill feed and in engine-generated text; the plugin's own chat lines are
 *    unaffected because they read the cached `reg.nameOf`. Because the prefix lands on the engine's
 *    own name field, the real name has to survive everything that can happen while a tag is on: it
 *    is cached before the first prefix is written, put back at the next countdown (BEFORE
 *    `beginRound` refreshes the registry's name cache) and put back again by `resetIcons` on map
 *    change or unload — and, as a belt-and-braces third line, `setRoleTag` strips any tag THIS
 *    module could have written before it caches. The strip is what makes the cache idempotent: the
 *    round-end reveal leaves every player prefixed until the next countdown, and a map vote that
 *    resolves inside that window has `reg.seedFromEngine` re-read the live (prefixed) engine name,
 *    so without it "[T] Bob" would be re-cached as Bob's real name and grow a bracket per map.
 *  - **Only this plugin's own worldtext is destroyed** at round start. The C# killed every
 *    `point_worldtext` on the map, which would take a map's own signage with it.
 */

import { Player, wrapEntity, type Pawn } from "@s2script/cs2";
import { createEntity, type EntityRef } from "@s2script/sdk/entity";
import type { PrecacheContext } from "@s2script/sdk/sound";
import { nextFrame } from "@s2script/sdk/timers";
import { Transmit } from "@s2script/sdk/transmit";
import { Priority, type EventBus } from "../core/bus";
import { GameState, MAX_SLOTS, RoleId } from "../core/enums";
import type { TttEvents } from "../core/events";
import * as reg from "../core/registry";
import { inProgress } from "../game/game";
import { roleName } from "../game/roles";
import { ROLE_COLORS, type Rgb } from "./color";
import { pawnOf } from "./pawn";

/**
 * Role uniforms.
 *
 * The C# paths were `agents/models/...`, which is the pre-CS2 layout; the port already ships
 * `characters/models/tm_phoenix/tm_phoenix.vmdl` for corpses and that one is exercised at runtime,
 * so both uniforms use the same prefix. An unresolvable path yields an error model, which is worse
 * than leaving the player's own agent alone — hence the rejection warning.
 */

/**
 * Height above the pawn ORIGIN (its feet) that the icon is CENTRED on.
 *
 * The C# `TextSpawner.spawnHatPart` used 72 and that reads as "head height", but it is not where the
 * glyph ends up. The panel is `font_size` 64 at `world_units_per_pixel` 0.5 — a 32-unit-tall letter —
 * and `justify_vertical` is CENTER, so the anchor is the letter's MIDDLE, not its base. At 72 the
 * glyph therefore spans z 56..88 on a pawn that is 72 tall with its eyes at 64: it straddles the
 * wearer's own eye line and covers the head of anyone they look at.
 *
 * 96 puts the bottom of the glyph (96 - 16) at 80 — a clean 8 units of daylight above a standing
 * head, and well above the 64 eye line. Crouching only increases the gap, since the pawn origin
 * stays at the feet while the model gets shorter.
 */
const HAT_HEIGHT = 96;
/** Sideways nudge along the hat's own right vector, so the two panels do not z-fight. */
const HAT_SIDE_OFFSET = 5;
/** The two yaw offsets the original spawned its panels at. */
const HAT_YAWS: readonly number[] = [270, 180];

/**
 * Every marker entity for a slot, flat: `slot * PARTS + part`. Flat rather than nested so it
 * stays the slot-indexed shape the rest of the plugin uses, with no per-slot sub-array to allocate.
 */
const PARTS = 4;
/** Part indexes within a slot's block. 0/1 are the worldtext panels, 2/3 the glow pair. */
const PART_GLOW_RELAY = 2;
const PART_GLOW_MODEL = 3;
const icons: (EntityRef | null)[] = new Array<EntityRef | null>(MAX_SLOTS * PARTS).fill(null);

/**
 * Slots holding a Traitor icon this round — the transpose of `traitorsThisRound`. Death does not
 * remove a slot (the C# did not either; the icon is destroyed on death, so a stale viewer entry has
 * nothing to reveal), but a DISCONNECT does: a slot with nobody in it can be reoccupied mid-round,
 * and the new client would inherit the departed Traitor's view. See the `leave` handler.
 */
const traitors: number[] = [];

/** Slots whose icon has been permanently revealed (Stickers) — a later refresh must not re-hide it. */
const revealed = new Uint8Array(MAX_SLOTS);

/** Slots that bought Stickers this round (the C# `Shop.HasItem<Stickers>` test). */
const stickers = new Uint8Array(MAX_SLOTS);

/** Slots currently wearing a role tag on their name, and the real name to put back. */
const tagged = new Uint8Array(MAX_SLOTS);
const realNames: string[] = new Array<string>(MAX_SLOTS).fill("");

/** Warn once rather than every frame if the transmit capability is not available on this runtime. */
let warnedNoTransmit = false;

/**
 * Role uniforms — the two agent models `RoleIconsHandler` swaps players into.
 *
 * THE PATH PREFIX IS LOAD-BEARING. An earlier attempt used `characters/models/...` and produced the
 * pink-and-black ERROR model for every player the moment roles were dealt, with the engine logging
 * `RESOURCE_TYPE_MODEL ... requested but not resident (Missing from a manifest?)`. That was not a
 * precache or residency problem at all — `characters/models/tm_phoenix/` contains only a `materials`
 * subtree and no `.vmdl`, so the path simply did not name a model. The compiled agent models live
 * under `agents/models/`, which is what the C# used and what is verified present in `pak01_dir.vpk`.
 *
 * `setModel` returns true either way, so a wrong path here fails silently at the API and only shows
 * up on screen — which is exactly how it survived as long as it did.
 */
const T_MODEL = "agents/models/tm_phoenix/tm_phoenix.vmdl";
const CT_MODEL = "agents/models/ctm_fbi/ctm_fbi_varianth.vmdl";

/** The uniform a role wears: the Detective is publicly CT, everyone else is T. */
export function roleModel(role: RoleId): string {
  return role === RoleId.Detective ? CT_MODEL : T_MODEL;
}

export function precacheRoleModels(pc: PrecacheContext): void {
  pc.add(T_MODEL);
  pc.add(CT_MODEL);
}
/**
 * The letter to float over the head — the C# took the first ASCII letter of the *localised* role
 * name, so a phrase-file override changes the marker with it. A non-Latin phrase table has no
 * ASCII letter to take, in which case the first character is a better marker than nothing.
 */
function iconLetter(role: RoleId): string {
  const name = roleName(role);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return name.charAt(i);
  }
  return name.length > 0 ? name.charAt(0) : "?";
}

/**
 * One panel of a hat — the port of `TextSpawner.spawnHatPart`.
 *
 * The 5-unit nudge is along the panel's OWN right vector (`VectorExtensions.ToRight` on the
 * already-rotated angle), which with the +90 roll works out to a horizontal offset opposite the
 * panel's facing — that is what separates the yaw+270 and yaw+180 panels around the head.
 */
function spawnHatPart(
  pawn: Pawn,
  ox: number,
  oy: number,
  oz: number,
  pitch: number,
  yaw: number,
  roll: number,
  text: string,
  c: Rgb,
): EntityRef | null {
  const rad = Math.PI / 180;
  const sp = Math.sin(pitch * rad);
  const cp = Math.cos(pitch * rad);
  const sy = Math.sin(yaw * rad);
  const cy = Math.cos(yaw * rad);
  const sr = Math.sin(roll * rad);
  const cr = Math.cos(roll * rad);
  const rightX = sy * sp * cr - cy * sr;
  const rightY = -cy * sp * cr - sy * sr;
  const rightZ = cp * -sr;

  const ent = createEntity("point_worldtext", {
    message: text,
    enabled: true,
    fullbright: true,
    // The text colour is a `point_worldtext` spawn keyvalue (m_Color), NOT the m_clrRender field
    // color.ts has to route around — so the missing-schema-field restriction does not apply here.
    color: `${c.r | 0} ${c.g | 0} ${c.b | 0} 255`,
    font_name: "Arial",
    font_size: 64,
    world_units_per_pixel: 0.5,
    justify_horizontal: 1, // CENTER — the letter hangs centred over the head
    justify_vertical: 1, // CENTER
    reorient_mode: 0, // NONE, matching the C# TextSetting defaults
  });
  if (ent === null) return null;

  // Absolute placement FIRST, parent SECOND. `acceptInput` queues on the engine's same-tick I/O
  // pump and SetParent re-bases whatever transform the entity has when it runs, so parenting first
  // would turn the world position into a local offset from the pawn and throw the hat across the
  // map. This is the order the C# used, for the same reason.
  ent.teleport(
    [
      ox + rightX * HAT_SIDE_OFFSET,
      oy + rightY * HAT_SIDE_OFFSET,
      oz + HAT_HEIGHT + rightZ * HAT_SIDE_OFFSET,
    ],
    [pitch, yaw, roll],
    null,
  );
  ent.acceptInput("SetParent", "!activator", pawn.ref);
  return ent;
}

/**
 * `RenderMode_t::kRenderNone` — the model is not drawn; its glow pass still is.
 *
 * 2, NOT 1. 1 is `kRenderTransAlpha`, which is why the glow still looked right with the wrong value:
 * transparent happened to be close enough to invisible. Confirmed against the schema enum dump
 * (kRenderNormal 0, kRenderTransAlpha 1, kRenderNone 2).
 */
const RENDER_NONE = 2;

/** Pack an RGBA colour into the uint32 `m_clrRender` / `m_glowColorOverride` hold (R in low byte). */
function packRgba(c: Rgb, a: number): number {
  return ((c.r & 0xff) | ((c.g & 0xff) << 8) | ((c.b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
}

/**
 * Give `slot` a role-coloured outline, drawn for whoever the transmit rule later allows.
 *
 * Glow is a property of an ENTITY, and the entity here cannot be the player's own pawn: glow has no
 * per-viewer form, so a glowing pawn glows for everyone and announces the Traitor to the server.
 * Hiding the pawn instead is not an option either — transmit filtering hides the whole entity, which
 * would make the player invisible rather than un-glowing. So the glow lives on a throwaway copy that
 * can be hidden from non-Traitors while the real pawn is untouched.
 *
 * TWO entities, not one. A prop given `FollowEntity` bone-merges onto the target and animates with
 * it, but the glow pass does not render correctly on the same entity that is doing the merge — the
 * established CS2 recipe chains a relay (merged onto the pawn) and a glow model (merged onto the
 * relay). Both wear the player's own uniform so the outline traces the player's silhouette.
 *
 * Both are hidden with `m_nRenderMode = kRenderNone`, which is what the reference implementations
 * use: the model itself is not drawn while the glow pass, which runs separately, still is. This was
 * previously an alpha-0 trick on `m_clrRender` because `m_nRenderMode` is a `RenderMode_t` — an enum,
 * and enums were skipped wholesale for want of a byte width. Alpha 0 happened to work, but it asks
 * the renderer for a fully transparent model rather than for no model, which is a different question
 * with a coincidentally similar answer.
 *
 * Returns false and cleans up if either half fails, so a partial pair never survives — a bare relay
 * would be an un-glowing duplicate of the player standing in their shoes.
 */
function spawnGlow(slot: number, pawn: Pawn, role: RoleId): boolean {
  const c = ROLE_COLORS[role];
  if (c === undefined) return false;
  const model = roleModel(role);
  const base = slot * PARTS;

  const relay = createEntity("prop_dynamic");
  if (relay === null) return false;
  relay.setModel(model);
  if (!relay.spawn({ targetname: `ttt_glow_relay_${slot}` })) {
    relay.remove();
    return false;
  }

  const glow = createEntity("prop_dynamic");
  if (glow === null) {
    relay.remove();
    return false;
  }
  glow.setModel(model);
  if (!glow.spawn({ targetname: `ttt_glow_${slot}` })) {
    relay.remove();
    glow.remove();
    return false;
  }

  // `createEntity` hands back a bare EntityRef; the schema field accessors come from wrapEntity.
  // The wrapper is a view over the ref, so it stays correct as the entity changes.
  const relayFields = wrapEntity("CBaseModelEntity", relay);
  const glowFields = wrapEntity("CBaseModelEntity", glow);

  relayFields.renderMode = RENDER_NONE;
  glowFields.renderMode = RENDER_NONE;

  const g = glowFields.glow;
  g.glowColorOverride = packRgba(c, 255);
  g.glowType = 3;
  g.glowTeam = -1;
  g.glowRange = 5000;
  g.glowRangeMin = 100;
  // Written LAST: the others are read when the glow is switched on, so flipping this first can
  // latch a half-configured (white, zero-range) outline for a frame.
  g.glowing = true;

  relay.acceptInput("FollowEntity", "!activator", pawn.ref, relay);
  glow.acceptInput("FollowEntity", "!activator", relay, glow);

  icons[base + PART_GLOW_RELAY] = relay;
  icons[base + PART_GLOW_MODEL] = glow;
  return true;
}

/** Spawn both panels for `slot`. Returns false if the pawn or either panel would not resolve. */
function spawnIcons(slot: number, pawn: Pawn, role: RoleId): boolean {
  const c = ROLE_COLORS[role];
  const origin = pawn.origin;
  if (c === undefined || origin === null) return false;

  const angles = pawn.angles;
  // Body rotation, NOT eyeAngles — a hat that pitched with the player's aim would tumble.
  const pitch = angles === null ? 0 : angles.x;
  const yaw = angles === null ? 0 : angles.y;
  const roll = angles === null ? 0 : angles.z;

  const letter = iconLetter(role);
  const base = slot * PARTS;
  for (let i = 0; i < HAT_YAWS.length; i++) {
    const ent = spawnHatPart(
      pawn,
      origin.x,
      origin.y,
      origin.z,
      pitch,
      yaw + HAT_YAWS[i]!,
      roll + 90,
      letter,
      c,
    );
    if (ent === null) {
      removeIcons(slot); // half a hat is worse than none — it reads as a different marker
      return false;
    }
    icons[base + i] = ent;
  }

  // Traitors only. A Detective outline would be pointless — their icon is already public — and it
  // would glow for everyone, since a Detective's marker carries no transmit rule to inherit.
  if (role === RoleId.Traitor && !spawnGlow(slot, pawn, role)) {
    console.log(`[ttt] WARN: glow spawn failed slot=${slot}`);
  }
  return true;
}

/** Destroy `slot`'s panels and drop their visibility rules. */
function removeIcons(slot: number): void {
  const base = slot * PARTS;
  for (let i = 0; i < PARTS; i++) {
    const ent = icons[base + i];
    if (ent === null) continue;
    // Release the rule before the entity so the native table does not carry a dead entry.
    Transmit.reset(ent);
    ent.remove();
    icons[base + i] = null;
  }
}

/** True if `slot` currently has panels in the world. */
function hasIcons(slot: number): boolean {
  return icons[slot * PARTS] !== null;
}

/**
 * Restrict `slot`'s panels to `viewers`. FAIL-CLOSED: a refused rule destroys the icon, because an
 * unrestricted Traitor icon would announce every Traitor to the whole server.
 */
function restrictIcons(slot: number, viewers: readonly number[]): void {
  const base = slot * PARTS;
  for (let i = 0; i < PARTS; i++) {
    const ent = icons[base + i];
    if (ent === null) continue;
    if (Transmit.setVisibleTo(ent, viewers)) continue;
    if (!warnedNoTransmit) {
      warnedNoTransmit = true;
      console.log("[ttt] WARN: transmit filtering unavailable — hiding role icons instead of leaking them");
    }
    removeIcons(slot);
    return;
  }
}

/** Drop every rule on `slot`'s panels, i.e. show them to everyone (the C# `RevealToAll`). */
function unrestrictIcons(slot: number): void {
  const base = slot * PARTS;
  for (let i = 0; i < PARTS; i++) {
    const ent = icons[base + i];
    if (ent !== null) Transmit.reset(ent);
  }
}

/**
 * Re-push the traitor viewer list onto every Traitor icon.
 *
 * `traitorsThisRound` grows as roles are dealt, and `setVisibleTo` REPLACES a rule rather than
 * merging into it, so every existing Traitor icon has to be re-pushed each time a new Traitor
 * appears — the transpose of the C# double loop that OR'd the new bit into every traitor's mask.
 */
function refreshTraitorIcons(): void {
  for (let i = 0; i < traitors.length; i++) {
    const slot = traitors[i]!;
    if (revealed[slot] === 1) continue; // Stickers already made this one public; do not re-hide it
    restrictIcons(slot, traitors);
  }
}

/**
 * Apply the uniform and the icon, one frame after the role was dealt.
 *
 * `applyRoleTeam` runs `switchTeam` immediately after the `roleAssign` dispatch and the engine MAY
 * respawn the pawn inside that call, which puts it back in the staging list. `SetModel`/`SetParent`
 * on a staged pawn segfaults even though the ref reads live — the C# hit the same assertion and
 * solved it the same way, by deferring to the next world update. `retries` covers the case where
 * the respawn has not finished by then.
 */
function applyRoleVisuals(slot: number, role: RoleId, retries: number): void {
  void nextFrame().then(() => {
    // The role may have been re-dealt (or the player cut) while we waited.
    if (reg.roleOf(slot) !== role) return;
    const pawn = pawnOf(slot);
    if (pawn === null || !pawn.isValid) {
      if (retries > 0) applyRoleVisuals(slot, role, retries - 1);
      return;
    }

    // Panels FIRST, model swap second — and the swap on the FOLLOWING frame.
    //
    // This is the C# order (`assignIcon` synchronous, `SetModel` inside `NextWorldUpdate`) and it is
    // load-bearing, not stylistic. `setModel` puts the pawn back in the staging list, and a staged
    // pawn reports a null `origin` — which `spawnIcons` treats as "cannot place a panel" and bails
    // on. Running the swap first therefore destroyed every icon in the mode silently: role assign
    // reported success, no entity was ever created, and `point_worldtext` sat at 0 with live
    // Traitors on the server.
    //
    // An earlier comment here claimed the reverse — that a model swap rebuilds the skeleton the
    // panels hang off, so panels had to come second. The C# has run this order in production for
    // years; the panels survive the swap.
    if (role === RoleId.Traitor || role === RoleId.Detective) {
      if (spawnIcons(slot, pawn, role)) {
        // A Detective icon gets NO rule: visible to everyone, late joiners included.
        if (role === RoleId.Traitor) refreshTraitorIcons();
      } else {
        console.log(`[ttt] WARN: icon spawn failed slot=${slot} role=${role}`);
      }
    }

    void nextFrame().then(() => {
      const later = pawnOf(slot);
      if (later === null || !later.isValid || reg.roleOf(slot) !== role) return;
      later.ref.setModel(roleModel(role));
    });
  });
}

/**
 * Reveal `slot`'s role icon to the whole server for the rest of the round — the C#
 * `IIconManager.RevealToAll`, which Stickers is built on.
 *
 * Exported because it is the reveal primitive: anything that publicly outs a player (Stickers here,
 * the RTD "Proven" reward in the original) drives it.
 */
export function revealIconToAll(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  const role = reg.roleOf(slot);
  if (role === RoleId.None || role === RoleId.Spectator) return;

  if (!hasIcons(slot)) {
    // An Innocent has no panels yet (they are spawned on demand); make them now. A dead player
    // gets nothing: the C# destroyed the icon on death and `RevealToAll` never brought it back.
    if (!reg.isAlive(slot)) return;
    const pawn = pawnOf(slot);
    if (pawn === null || !pawn.isValid) return;
    if (!spawnIcons(slot, pawn, role)) return;
  }
  revealed[slot] = 1;
  unrestrictIcons(slot);
}

/** Mark `slot` as owning Stickers for this round. Called from the shop item. */
export function armStickers(slot: number): void {
  if (slot >= 0 && slot < MAX_SLOTS) stickers[slot] = 1;
}

/** Every role `setRoleTag` can be called with — the prefixes that may already be on a name. */
const TAG_ROLES: readonly RoleId[] = [
  RoleId.Innocent,
  RoleId.Traitor,
  RoleId.Detective,
  RoleId.Spectator,
];

/** The exact prefix `setRoleTag` writes for `role`. */
function roleTagPrefix(role: RoleId): string {
  return `[${iconLetter(role)}] `;
}

/**
 * Strip every prefix this module could have written off `name`.
 *
 * Matched against the live role prefixes rather than a generic `^\[.\] ` pattern for two reasons: a
 * phrase-file override can make the letter non-Latin (`iconLetter` falls back to the first
 * character), and a player whose own name genuinely starts with a bracketed initial keeps it. The
 * loop repeats because a tree that ran before this guard existed can carry "[T] [T] Bob"; each pass
 * removes at least four characters, so it always terminates.
 */
function stripRoleTags(name: string): string {
  let out = name;
  for (;;) {
    const before = out;
    for (let i = 0; i < TAG_ROLES.length; i++) {
      const prefix = roleTagPrefix(TAG_ROLES[i]!);
      if (out.startsWith(prefix)) {
        out = out.slice(prefix.length);
        break;
      }
    }
    if (out === before) return out;
  }
}

/**
 * Write a role tag onto the scoreboard name — the stand-in for `SetClan`, see the header.
 *
 * The real name is captured from the registry the first time a tag goes on, so the tag can never
 * be prefixed onto an already-prefixed name.
 */
function setRoleTag(slot: number, role: RoleId): void {
  const p = Player.fromSlot(slot);
  if (p === null) return;
  // `reg.nameOf` can hand back a name this module already prefixed — `reg.seedFromEngine` reads the
  // live engine name, and a map change during the round-end reveal window happens while every
  // participant is still tagged. Strip first so the cache holds the real name either way; without
  // this the tag nests one bracket deeper on every such map change.
  if (tagged[slot] === 0) realNames[slot] = stripRoleTags(reg.nameOf(slot));
  const real = realNames[slot]!;
  if (real === "") return;
  tagged[slot] = 1;
  p.setName(`[${iconLetter(role)}] ${real}`);
}

/** Put a tagged player's real name back. */
function clearRoleTag(slot: number): void {
  if (tagged[slot] !== 1) return;
  tagged[slot] = 0;
  const real = realNames[slot]!;
  if (real === "") return;
  Player.fromSlot(slot)?.setName(real);
}

/** Tag every participant with the role they actually held (`RoundTimerListener.revealRoles`). */
function tagAllRoles(): void {
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const slot = active[i]!;
    const role = reg.roleOf(slot);
    if (role === RoleId.None) continue; // joined mid-round: nothing to reveal
    setRoleTag(slot, role);
  }
}

/** Destroy every icon and forget the round's visibility state (the C# `OnRoundStart`). */
function clearAllIcons(): void {
  for (let slot = 0; slot < MAX_SLOTS; slot++) removeIcons(slot);
  traitors.length = 0;
  revealed.fill(0);
}

/**
 * Drop everything this module owns — map change and unload.
 *
 * `Transmit.resetAll` is safe to call from here because role icons are the only thing in this
 * plugin that installs a transmit rule.
 *
 * Call this BEFORE `reg.seedFromEngine()` on map start: the names have to be back on the engine
 * before anything re-reads them. (`setRoleTag`'s strip makes the wrong order survivable rather than
 * corrupting, but only this order leaves the player's own name on their scoreboard entry.)
 */
export function resetIcons(): void {
  clearAllIcons();
  // Put every tagged name back BEFORE the bookkeeping that knows what the real name was is dropped
  // — otherwise the round-end reveal's "[T] " outlives the module and becomes the player's name.
  // All slots, not `reg.activeSlots()`: on unload the roster may already be gone, and `clearRoleTag`
  // is a no-op for a slot this module never tagged.
  for (let slot = 0; slot < MAX_SLOTS; slot++) clearRoleTag(slot);
  stickers.fill(0);
  tagged.fill(0);
  realNames.fill("");
  Transmit.resetAll();
}

/** Register the icon, uniform and role-tag listeners. */
export function installIcons(bus: EventBus<TttEvents>): void {
  bus.on(
    "roleAssign",
    (ev) => {
      if (ev.canceled) return;
      const slot = ev.slot;
      const role = ev.role;

      // The C# rewrote the clan on every assignment — "Detective" for the Detective, empty for
      // everyone else — which is what stops last round's reveal from persisting into this one.
      if (role === RoleId.Detective) setRoleTag(slot, role);
      else clearRoleTag(slot);

      if (role === RoleId.None || role === RoleId.Spectator) return;

      removeIcons(slot); // in case this is a re-assignment
      // Recorded before the panels exist: every Traitor is dealt in this same frame, so by the
      // time the deferred spawns run the set is complete and one refresh covers all of them.
      // Bounded at 64 because `setVisibleTo` throws RangeError on a viewer outside [0, 64).
      if (role === RoleId.Traitor && slot >= 0 && slot < 64 && traitors.indexOf(slot) < 0) {
        traitors.push(slot);
      }
      applyRoleVisuals(slot, role, 1);
    },
    // MONITOR so the icon shows the role karma may have rewritten, not the one first dealt.
    { priority: Priority.MONITOR },
  );

  // Part of keeping the alive-illusion up: a dead player's marker must not hang over their corpse.
  bus.on("death", (ev) => removeIcons(ev.slot), { priority: Priority.MONITOR });

  bus.on(
    "bodyIdentify",
    (ev) => {
      // C# `BodyPickupListener` tags the body's owner with their real role — Traitors included.
      const owner = ev.body.owner;
      const role = ev.body.ownerRole;
      if (role === RoleId.None || role === RoleId.Spectator) return;
      if (reg.isConnected(owner)) setRoleTag(owner, role);
    },
    { ignoreCanceled: true, priority: Priority.MONITOR },
  );

  /**
   * Stickers — the port of `StickerListener.OnHurt`.
   *
   * The trigger is a *canceled* taser hit from someone holding the item, which is precisely what
   * the taser branch in effects.ts produces (it cancels the damage and scans the victim). Reading
   * `canceled` is why this subscribes without `ignoreCanceled`.
   */
  bus.on(
    "damage",
    (ev) => {
      if (!ev.canceled || !inProgress()) return;
      const attacker = ev.attacker;
      if (attacker < 0 || attacker >= MAX_SLOTS || stickers[attacker] !== 1) return;
      if (!ev.weapon.includes("taser")) return;
      revealIconToAll(ev.slot);
    },
    { priority: Priority.MONITOR },
  );

  bus.on(
    "gameState",
    (ev) => {
      if (ev.state === GameState.Countdown) {
        // Round start: kill last round's icons and put every tagged name back BEFORE `beginRound`
        // refreshes the registry's name cache off the engine — otherwise "[T] Bob" becomes the
        // name TTT believes Bob has.
        clearAllIcons();
        stickers.fill(0);
        const active = reg.activeSlots();
        for (let i = 0; i < active.length; i++) clearRoleTag(active[i]!);
        return;
      }
      // Round end reveals everyone's real role on the scoreboard.
      if (ev.state === GameState.Finished) tagAllRoles();
    },
    { ignoreCanceled: true },
  );

  bus.on("leave", (ev) => {
    removeIcons(ev.slot);
    stickers[ev.slot] = 0;
    tagged[ev.slot] = 0;
    realNames[ev.slot] = "";
    // Whoever takes this slot next inherits none of the departing player's state, so the reveal
    // flag goes with them — a stale 1 would make `refreshTraitorIcons` skip the new occupant.
    revealed[ev.slot] = 0;
    const i = traitors.indexOf(ev.slot);
    if (i < 0) return;
    traitors.splice(i, 1);
    // `setVisibleTo` REPLACES a snapshot of the viewer set, so dropping the slot from `traitors`
    // changes nothing engine-side until every live Traitor icon is re-pushed. Without this the
    // freed slot keeps transmit rights on every Traitor panel installed while it was occupied, and
    // the next client to take it sees the whole Traitor roster floating over their heads.
    refreshTraitorIcons();
  });
}
