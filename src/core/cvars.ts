/**
 * ConVar registration + the config snapshot.
 *
 * Every `sm_ttt_*` ConVar the C# build exposed is registered here under the same name, with the
 * same default and range, so an existing server's `ttt.cfg` keeps working unchanged.
 *
 * The difference is how they are READ. The C# config objects were resolved through
 * `provider.GetService<IStorage<T>>()?.Load().GetAwaiter().GetResult()` inside a **property getter** —
 * so `config.RoundCfg.MinimumPlayers` walked the DI container, allocated a fresh `TTTConfig` record
 * (and every nested record), blocked on a Task, and threw it all away, *per read*. Several of those
 * getters sat inside per-tick handlers.
 *
 * Here the ConVars are parsed once into {@link cfg}, a flat object with a stable hidden class, and
 * refreshed only at round boundaries. Reads are a single monomorphic property load.
 */

import { Server } from "@s2script/sdk/server";

type Kind = "int" | "float" | "bool" | "string";

interface Spec {
  readonly name: string;
  readonly kind: Kind;
  readonly def: number | boolean | string;
  readonly help: string;
  readonly min?: number;
  readonly max?: number;
}

const S = (
  name: string,
  kind: Kind,
  def: number | boolean | string,
  help: string,
  min?: number,
  max?: number,
): Spec => ({ name, kind, def, help, min, max });

/** Every ConVar this plugin owns. Names + defaults mirror the C# `CS2*Config` classes exactly. */
const SPECS: readonly Spec[] = [
  // ── round / game ────────────────────────────────────────────────────────────
  S("sm_ttt_round_countdown", "int", 15, "Time to wait before starting a round", 1, 60),
  S("sm_ttt_minimum_players", "int", 2, "Minimum number of players to start a round", 2, 64),
  S("sm_ttt_round_duration_base", "int", 60, "Base round duration in seconds", 30, 600),
  S("sm_ttt_round_duration_per_player", "int", 15, "Extra round seconds per player", 0, 60),
  S("sm_ttt_round_duration_max", "int", 300, "Maximum round duration in seconds", 60, 600),
  S("sm_ttt_time_between_rounds", "int", 1, "Time to wait between rounds in seconds", 1, 60),
  // The post-round free-roam window, matching CS's own round-end behaviour: the round ends,
  // everyone keeps moving for a few seconds, then the engine restarts and respawns them at
  // their spawn points. `mp_round_restart_delay` is what the ENGINE uses for that, so TTT keeps
  // the two in step rather than running a second, competing clock. 5 matches the SourceMod TTT
  // reference (`mp_match_restart_delay 5`).
  S("sm_ttt_post_round_seconds", "int", 5, "Seconds of free roam after a round ends, before the respawn", 1, 30),
  // ── roles ───────────────────────────────────────────────────────────────────
  S("sm_ttt_rolehp_traitor", "int", 100, "Traitor starting health", 1, 1000),
  S("sm_ttt_rolehp_detective", "int", 100, "Detective starting health", 1, 1000),
  S("sm_ttt_rolehp_innocent", "int", 100, "Innocent starting health", 1, 1000),
  S("sm_ttt_rolearmor_traitor", "int", 0, "Traitor starting armor", 0, 1000),
  S("sm_ttt_rolearmor_detective", "int", 0, "Detective starting armor", 0, 1000),
  S("sm_ttt_rolearmor_innocent", "int", 0, "Innocent starting armor", 0, 1000),
  S("sm_ttt_roleweapons_traitor", "string", "", "Traitor starting weapons (comma-separated)"),
  S(
    "sm_ttt_roleweapons_detective",
    "string",
    "weapon_taser,weapon_m4a1_silencer,weapon_revolver",
    "Detective starting weapons (comma-separated)",
  ),
  S("sm_ttt_roleweapons_innocent", "string", "", "Innocent starting weapons (comma-separated)"),
  // ── karma ───────────────────────────────────────────────────────────────────
  S("sm_ttt_karma_db_string", "string", "karma", "Database connection name for karma storage"),
  S("sm_ttt_karma_default", "int", 50, "Default karma for new or reset players", 0, 1000),
  S("sm_ttt_karma_min", "int", 0, "Minimum karma; below this the low-karma command runs", 0, 1000),
  S(
    "sm_ttt_karma_low_command",
    "string",
    "sm_ban #{0} 2880 Low Karma",
    "Command run when karma falls below the minimum ({0} = user id)",
  ),
  S("sm_ttt_karma_timeout_threshold", "int", 20, "Karma below which a player sits out", 0, 1000),
  S("sm_ttt_karma_round_timeout", "int", 4, "Rounds a low-karma player sits out", 0, 100),
  S("sm_ttt_karma_warning_window_hours", "int", 24, "Hours between repeat karma warnings", 0, 720),
  S("sm_ttt_karma_per_round", "int", 1, "Karma gained per round played", -100, 100),
  S("sm_ttt_karma_per_round_win", "int", 1, "Karma gained per round won", -100, 100),
  S("sm_ttt_karma_inno_on_traitor", "int", 3, "Karma for a non-Traitor killing a Traitor", -100, 100),
  S("sm_ttt_karma_traitor_on_detective", "int", 1, "Karma for a Traitor killing a Detective", -100, 100),
  S("sm_ttt_karma_inno_on_inno_innocent", "int", 0, "Inno kills Inno, retaliating", -100, 100),
  S("sm_ttt_karma_inno_on_inno_guilty", "int", -4, "Inno kills Inno, unprovoked", -100, 100),
  S("sm_ttt_karma_inno_on_inno_victim_innocent", "int", 1, "Inno victim, killer unprovoked", -100, 100),
  S("sm_ttt_karma_inno_on_inno_victim_guilty", "int", -2, "Inno victim, they started it", -100, 100),
  S("sm_ttt_karma_traitor_on_traitor_innocent", "int", -3, "Traitor kills Traitor, retaliating", -100, 100),
  S("sm_ttt_karma_traitor_on_traitor_guilty", "int", -5, "Traitor kills Traitor, unprovoked", -100, 100),
  S("sm_ttt_karma_traitor_on_traitor_victim_innocent", "int", 1, "Traitor victim, killer unprovoked", -100, 100),
  S("sm_ttt_karma_traitor_on_traitor_victim_guilty", "int", -2, "Traitor victim, they started it", -100, 100),
  S("sm_ttt_karma_inno_on_detective_innocent", "int", -4, "Inno kills Detective, retaliating", -100, 100),
  S("sm_ttt_karma_inno_on_detective_guilty", "int", -6, "Inno kills Detective, unprovoked", -100, 100),
  S("sm_ttt_karma_inno_on_detective_victim_innocent", "int", 1, "Detective victim, killer unprovoked", -100, 100),
  S("sm_ttt_karma_inno_on_detective_victim_guilty", "int", -1, "Detective victim, they started it", -100, 100),
  // ── shop economy ────────────────────────────────────────────────────────────
  S("sm_ttt_shop_start_innocent", "int", 60, "Starting credits for Innocents", 0, 10000),
  S("sm_ttt_shop_start_traitor", "int", 100, "Starting credits for Traitors", 0, 10000),
  S("sm_ttt_shop_start_detective", "int", 120, "Starting credits for Detectives", 0, 10000),
  S("sm_ttt_shop_inno_v_inno", "int", -4, "Credits when Innocent kills Innocent", -10000, 10000),
  S("sm_ttt_shop_inno_v_traitor", "int", 8, "Credits when Innocent kills Traitor", -10000, 10000),
  S("sm_ttt_shop_inno_v_detective", "int", -6, "Credits when Innocent kills Detective", -10000, 10000),
  S("sm_ttt_shop_traitor_v_traitor", "int", -5, "Credits when Traitor kills Traitor", -10000, 10000),
  S("sm_ttt_shop_traitor_v_inno", "int", 4, "Credits when Traitor kills Innocent", -10000, 10000),
  S("sm_ttt_shop_traitor_v_detective", "int", 6, "Credits when Traitor kills Detective", -10000, 10000),
  S("sm_ttt_shop_detective_v_detective", "int", -8, "Credits when Detective kills Detective", -10000, 10000),
  S("sm_ttt_shop_detective_v_inno", "int", -6, "Credits when Detective kills Innocent", -10000, 10000),
  S("sm_ttt_shop_detective_v_traitor", "int", 8, "Credits when Detective kills Traitor", -10000, 10000),
  S("sm_ttt_shop_any_kill", "int", 2, "Credits for a kill with unknown roles", -10000, 10000),
  S("sm_ttt_shop_assist_multiplier", "float", 0.5, "Multiplier on assister credits", 0, 10),
  S("sm_ttt_shop_solo_kill_multiplier", "float", 1.5, "Multiplier on unassisted kill credits", 0, 10),
  S("sm_ttt_shop_reward_interval", "int", 30, "Seconds between exploration rewards", 5, 600),
  S("sm_ttt_shop_reward_min", "int", 2, "Minimum exploration reward", 0, 1000),
  S("sm_ttt_shop_reward_max", "int", 15, "Maximum exploration reward", 0, 1000),
  // ── shop items ──────────────────────────────────────────────────────────────
  S("sm_ttt_shop_armor_price", "int", 75, "Price of the Armor item", 0, 10000),
  S("sm_ttt_shop_armor_amount", "int", 100, "Armor granted by the Armor item", 0, 1000),
  S("sm_ttt_shop_armor_helmet", "bool", true, "Armor item also grants a helmet"),
  S("sm_ttt_shop_taser_price", "int", 110, "Price of the Taser item", 0, 10000),
  S("sm_ttt_shop_taser_weapon", "string", "weapon_taser", "Weapon entity for the Taser"),
  S("sm_ttt_shop_healthshot_price", "int", 40, "Price of the Healthshot", 0, 10000),
  S("sm_ttt_shop_healthshot_max_purchases", "int", 2, "Healthshot purchases per round", 0, 100),
  S("sm_ttt_shop_healthshot_weapon", "string", "weapon_healthshot", "Weapon entity for the Healthshot"),
  S("sm_ttt_shop_m4a1_price", "int", 50, "Price of the M4A1 item", 0, 10000),
  S("sm_ttt_shop_m4a1_clear_slots", "string", "0,1", "Slots cleared when granting the M4A1"),
  S(
    "sm_ttt_shop_m4a1_weapons",
    "string",
    "weapon_m4a1_silencer,weapon_usp_silencer",
    "Weapons granted by the M4A1 item",
  ),
  S("sm_ttt_shop_onedeagle_price", "int", 130, "Price of the One-Shot Revolver", 0, 10000),
  S("sm_ttt_shop_onedeagle_weapon", "string", "weapon_revolver", "Weapon entity for the One-Shot Revolver"),
  S("sm_ttt_shop_onedeagle_ff", "bool", false, "Whether the One-Shot Revolver damages teammates"),
  S("sm_ttt_shop_onedeagle_kill_shooter_on_ff", "bool", true, "Kill the shooter on a teammate hit"),
  S("sm_ttt_shop_stickers_price", "int", 45, "Price of the Stickers item (Detective)", 0, 10000),
  S("sm_ttt_shop_dna_price", "int", 110, "Price of the DNA Scanner (Detective)", 0, 10000),
  S("sm_ttt_shop_dna_decay_time", "int", 120, "Seconds before a DNA sample decays", 1, 3600),
  S("sm_ttt_shop_dna_max_samples", "int", 0, "Max stored DNA samples (0 = unlimited)", 0, 100),
  S("sm_ttt_shop_healthstation_price", "int", 50, "Price of the Health Station", 0, 10000),
  S("sm_ttt_shop_healthstation_interval", "int", 1, "Seconds between station health ticks", 1, 60),
  S("sm_ttt_shop_healthstation_increments", "int", 10, "Health applied per station tick", -1000, 1000),
  S("sm_ttt_shop_healthstation_total_health_given", "int", 0, "Total health a station gives (0 = infinite)", -100000, 100000),
  S("sm_ttt_shop_healthstation_station_health", "int", 200, "Health of the station entity", 1, 10000),
  S("sm_ttt_shop_healthstation_max_range", "float", 256, "Station effect radius in units", 50, 2048),
  S("sm_ttt_shop_healthstation_use_sound", "string", "sounds/buttons/blip1", "Station use sound"),
  S("sm_ttt_shop_damagestation_price", "int", 65, "Price of the Hurt Station (Traitor)", 0, 10000),
  S("sm_ttt_shop_damagestation_increments", "int", -25, "Damage applied per hurt-station tick", -1000, 1000),
  // `DamageStationConfig.TotalHealthGiven` is -3000; this is its magnitude, because the hurt
  // station's budget is spent in damage and the sign already lives in the increment above.
  S("sm_ttt_shop_damagestation_total_damage", "int", 3000, "Total damage a Hurt Station deals before depleting (0 = infinite)", 0, 100000),
  S("sm_ttt_shop_damagestation_max_purchases", "int", 3, "Hurt Stations purchasable per round", 0, 100),
  S("sm_ttt_shop_c4_price", "int", 130, "Price of the C4 (Traitor)", 0, 10000),
  S("sm_ttt_shop_c4_weapon", "string", "weapon_c4", "Weapon entity for the C4"),
  S("sm_ttt_shop_c4_fuse_time", "int", 30, "C4 fuse time in seconds", 1, 600),
  S("sm_ttt_shop_c4_power", "float", 100, "C4 explosion damage at the epicentre", 0, 10000),
  S("sm_ttt_shop_c4_max_at_once", "int", 1, "Max simultaneously active C4", 0, 100),
  S("sm_ttt_shop_c4_max_per_round", "int", 0, "Max C4 purchased per round (0 = unlimited)", 0, 100),
  S("sm_ttt_shop_c4_ff", "bool", false, "Whether the C4 damages fellow Traitors"),
  S("sm_ttt_shop_camo_price", "int", 65, "Price of the Camouflage item", 0, 10000),
  S("sm_ttt_shop_camo_visibility", "float", 0.5, "Visibility multiplier while camouflaged", 0, 1),
  S("sm_ttt_shop_bodypaint_price", "int", 30, "Price of the Body Paint item", 0, 10000),
  S("sm_ttt_shop_bodypaint_max_uses", "int", 4, "Body Paint uses per purchase", 1, 100),
  S("sm_ttt_shop_bodypaint_color", "string", "GreenYellow", "Body Paint colour (name or #RRGGBB)"),
  S("sm_ttt_shop_gloves_price", "int", 40, "Price of the Gloves (Traitor)", 0, 10000),
  S("sm_ttt_shop_gloves_max_uses", "int", 5, "Gloves uses before they wear out", 1, 100),
  S("sm_ttt_shop_onehitknife_price", "int", 80, "Price of the One-Hit Knife (Traitor)", 0, 10000),
  S("sm_ttt_shop_onehitknife_friendly_fire", "bool", false, "Whether the One-Hit Knife hits teammates"),
  S("sm_ttt_shop_silentawp_price", "int", 80, "Price of the Silent AWP (Traitor)", 0, 10000),
  S("sm_ttt_shop_silentawp_weapon", "string", "weapon_awp", "Weapon entity for the Silent AWP"),
  S("sm_ttt_shop_silentawp_index", "int", 9, "Weapon slot index for the Silent AWP", 0, 64),
  S("sm_ttt_shop_silentawp_current_ammo", "int", 1, "Silent AWP loaded ammo", 0, 100),
  S("sm_ttt_shop_silentawp_reserve_ammo", "int", 0, "Silent AWP reserve ammo", 0, 100),
  S("sm_ttt_shop_poisonsmoke_price", "int", 45, "Price of the Poison Smoke (Traitor)", 0, 10000),
  S("sm_ttt_shop_poisonsmoke_weapon", "string", "weapon_smokegrenade", "Weapon entity for Poison Smoke"),
  S("sm_ttt_shop_poisonsmoke_radius", "float", 180, "Poison Smoke effect radius", 16, 1024),
  S("sm_ttt_shop_poisonsmoke_poison_tick_interval", "int", 500, "Milliseconds between poison ticks", 50, 10000),
  S("sm_ttt_shop_poisonsmoke_poison_damage_per_tick", "int", 15, "Damage per poison tick", 0, 1000),
  S("sm_ttt_shop_poisonsmoke_poison_total_damage", "int", 500, "Total poison damage", 0, 10000),
  S(
    "sm_ttt_shop_poisonsmoke_poison_sound",
    "string",
    "sounds/player/player_damagebody_03",
    "Sound played on a poison tick",
  ),
  S("sm_ttt_shop_poisonshots_price", "int", 40, "Price of Poison Shots (Traitor)", 0, 10000),
  S("sm_ttt_shop_poisonshots_total", "int", 5, "Poisoned shots granted", 1, 100),
  S("sm_ttt_shop_clustergrenade_price", "int", 100, "Price of the Cluster Grenade (Traitor)", 0, 10000),
  S("sm_ttt_shop_clustergrenade_weapon", "string", "weapon_hegrenade", "Weapon entity for the Cluster Grenade"),
  S("sm_ttt_shop_clustergrenade_count", "int", 8, "Fragments released on detonation", 1, 64),
  S("sm_ttt_shop_clustergrenade_up_force", "float", 200, "Upward force on cluster fragments", 0, 2000),
  S("sm_ttt_shop_clustergrenade_throw_force", "float", 250, "Forward force on cluster fragments", 0, 2000),
  S("sm_ttt_shop_compass_price", "int", 60, "Price of the Compass items", 0, 10000),
  S("sm_ttt_shop_compass_max_range", "float", 10000, "Compass detection range", 100, 100000),
  S("sm_ttt_shop_compass_fov", "float", 120, "Compass field of view in degrees", 10, 360),
  S("sm_ttt_shop_compass_length", "int", 64, "Compass strip width in characters", 8, 256),
  S("sm_ttt_shop_tripwire_price", "int", 45, "Price of the Tripwire (Traitor)", 0, 10000),
  S("sm_ttt_shop_tripwire_explosion_power", "int", 1000, "Tripwire explosion damage", 0, 100000),
  // 0.02 is `TripwireConfig.FalloffDelay`; the exponential falloff curve is calibrated on it.
  // 0.015, the C#'s `CV_FALLOFF_DELAY`. It had drifted to 0.02, which is a much steeper curve than it
  // looks: 1000 * e^(-d * k) gives 223 damage at 100u with 0.015 and only 135 with 0.02, and by 200u
  // it is 50 against 18. The tripwire read as barely hurting anyone. The comment on the damage
  // calculation in `effects.ts` was already written against the 223 figure, so the constant was the
  // thing that was wrong, not the maths.
  S("sm_ttt_shop_tripwire_falloff_delay", "float", 0.015, "Tripwire damage falloff rate", 0, 10),
  S("sm_ttt_shop_tripwire_friendlyfire_multiplier", "float", 0.5, "Tripwire friendly-fire multiplier", 0, 10),
  S("sm_ttt_shop_tripwire_friendlyfire_triggers", "bool", true, "Whether teammates trigger a Tripwire"),
  S("sm_ttt_shop_tripwire_friendlyfire_karma_penalty_time", "int", 15, "Seconds a Tripwire teamkill costs karma (-1 = always)", -1, 3600),
  S("sm_ttt_shop_tripwire_max_distance_squared", "float", 50000, "Max Tripwire placement distance squared", 0, 10000000),
  // How far the wire reaches for the opposite surface. Was a hardcoded 512 — shorter than most rooms,
  // so a wire strung anywhere but a doorway found nothing and fell back to a stub. The C# puts no
  // length on its span trace, so this is generous by default.
  S("sm_ttt_shop_tripwire_max_span", "float", 4096, "How far a Tripwire reaches for the opposite surface", 64, 16384),
  // This defaulted OFF while transmit filtering was the leading suspect for the
  // `CopyExistingEntity: missing client entity` fatals — the glow twin is an extra networked prop
  // carrying a per-viewer transmit rule, so it was the obvious thing to take out of the picture.
  // The bisect since undercut that theory: a crash reproduced on a kill involving a player with no
  // transmit-filtered entities at all, and a long session with icons (which use the same mechanism)
  // fully enabled produced none. Filtering is no longer the reason to keep this off, so it is on.
  S("sm_ttt_shop_tripwire_glow", "bool", true, "Traitor-only glow on placed Tripwires"),
  // DEFAULTS OFF as a crash mitigation, not a preference.
  //
  // The DNA marker is a prop_dynamic PAIR chained with FollowEntity (glow -> relay -> target pawn) and
  // BOTH halves are restricted to a single viewer with `Transmit.setVisibleTo`. That is a
  // transmit-filtered entity whose parent is itself transmit-filtered — exactly the shape that leaves
  // a client holding a handle to an entity it was never sent, which is what
  // `CopyExistingEntity: missing client entity N` reports. Two crash indices from a live playtest
  // (666, 670) fell in the gaps BETWEEN our traced entities, and crashes continued after role icons
  // were disabled — this pair is untraced and independent of that switch, which fits both facts.
  //
  // The DNA scanner still works without it: the bearing/range/clock HUD and the identification are
  // untouched. Only the through-wall outline on the killer is gone.
  // Floating worldtext role panels. OFF: they are four networked entities per marked player, freed
  // and re-made every round, and that index churn is what drops clients with `CopyExistingEntity`.
  // The Traitor glow (two entities, and the thing players actually read) is unaffected.
  S("sm_ttt_role_panels", "bool", false, "Floating worldtext role panels above marked players"),
  // The role-colour screen wash on assignment. 0 disables it entirely.
  S("sm_ttt_role_flash_seconds", "int", 4, "Seconds the role-colour screen wash lasts (0 = off)", 0, 30),
  // NEVER FADES BY DEFAULT (0), because the glow IS the traitor-buddy indicator.
  //
  // This shipped at 4 seconds on the theory that the glow was a brief "here is what you were dealt"
  // confirmation, and that the floating worldtext marker was what Traitors used to find each other.
  // That had it backwards: players read the GLOW. Fading it meant the buddy indicator lit up and then
  // vanished, reported from a live server as the glow "working and then disappearing". A positive
  // value still fades it for anyone who wants that; the default no longer takes the feature away.
  S("sm_ttt_role_glow_seconds", "int", 0, "Seconds the role glow stays up (0 = never fade)", 0, 120),
  S("sm_ttt_dna_glow", "bool", false, "Through-wall glow marking the killer for the DNA scanner"),
  // --- crash bisect switches ---------------------------------------------------------------
  // Clients have hard-crashed with `CopyExistingEntity: missing client entity N`, which is what a
  // client says about an entity it was never sent. TRANSMIT FILTERING is the only mechanism here
  // that deliberately withholds an entity from some clients, and role icons are the entities it is
  // applied to. These exist so the suspicion can be tested by flipping one convar between rounds
  // instead of shipping another guess.
  S("sm_ttt_icons_enabled", "bool", true, "Role icons above heads (transmit-filtered). Off = bisect"),
  S("sm_ttt_bodies_enabled", "bool", true, "Corpses on death. Off = bisect"),
  // Corpse-path bisect. Disabling bodies wholesale removes THREE things at once — the ragdoll entity,
  // the pawn alpha-hide, and the settle pass — so "bodies off = no crash" does not say which. These
  // split them.
  S("sm_ttt_body_hidepawn", "bool", true, "Hide the victim's pawn once the corpse exists. Off = bisect"),
  S("sm_ttt_body_settle", "bool", true, "Settle pass (ClearParent + MoveType + teleport) on the corpse. Off = bisect"),
  // How far back along the carrier's RIGHT vector a carried corpse's root is pulled, so the beam ends
  // at its middle instead of an end. Live-tunable because the exact figure depends on the model and
  // on how the held pose lands its axes — easier to dial in than to derive.
  S("sm_ttt_carry_body_offset", "float", 36, "Carried corpse centring offset (units)", -128, 128),
  S("sm_ttt_shop_tripwire_initiation_time", "float", 2, "Seconds before a Tripwire arms", 0, 60),
  // `TripwireConfig.TripwireSizeSquared`. SQUARED units: 500 is a ~22u radius. The 10 this used to
  // default to is 3.2u, which is smaller than a player and left both the walk-through trigger and
  // the shoot-it trigger unhittable in practice.
  S("sm_ttt_shop_tripwire_size_squared", "float", 500, "Tripwire hit-detection radius squared", 0, 100000),
  // Back to the C#'s 0.5. It was raised to 2 while the wire appeared to be missing, but the beam was
  // never too thin — it had ZERO LENGTH, because the span traced along the player's aim into the wall
  // it had just hit instead of along the surface normal. With the geometry fixed, 2 is simply too fat.
  S("sm_ttt_shop_tripwire_thickness", "float", 0.5, "Tripwire beam thickness", 0.1, 10),
  S("sm_ttt_shop_tripwire_defuse_time", "float", 6, "Seconds to fully defuse a Tripwire", 0.1, 60),
  S("sm_ttt_shop_tripwire_defuse_rate", "float", 0.5, "Seconds between defuse ticks", 0.05, 10),
  S("sm_ttt_shop_tripwire_defuse_reward", "int", 20, "Credits for defusing a Tripwire", 0, 10000),
  S("sm_ttt_shop_tripwire_color_r", "int", 255, "Tripwire beam red channel", 0, 255),
  S("sm_ttt_shop_tripwire_color_g", "int", 0, "Tripwire beam green channel", 0, 255),
  S("sm_ttt_shop_tripwire_color_b", "int", 0, "Tripwire beam blue channel", 0, 255),
  S("sm_ttt_shop_tripwire_color_a", "int", 32, "Tripwire beam alpha", 0, 255),
  // ── special rounds ──────────────────────────────────────────────────────────
  S("sm_ttt_special_min_rounds_between", "int", 3, "Minimum rounds between special rounds", 0, 100),
  S("sm_ttt_special_min_players", "int", 5, "Minimum players for a special round", 0, 64),
  S("sm_ttt_special_min_rounds_after_map", "int", 2, "Rounds after a map change before a special", 0, 100),
  S("sm_ttt_special_chance", "float", 0.2, "Chance of a special round", 0, 1),
  S("sm_ttt_special_multi_chance", "float", 0.33, "Chance of stacking another special round", 0, 1),
  S("sm_ttt_special_lowgrav_multiplier", "float", 0.5, "Gravity multiplier for the Low Grav round", 0.05, 1),
  S("sm_ttt_special_speed_initial", "int", 40, "Speed round initial seconds", 5, 600),
  S("sm_ttt_special_speed_per_kill", "int", 8, "Speed round seconds added per kill", 0, 120),
  S("sm_ttt_special_speed_max", "int", 90, "Speed round maximum seconds", 10, 600),
  S("sm_ttt_special_rich_bonus_multiplier", "float", 2, "Rich round starting-credit multiplier", 1, 10),
  S("sm_ttt_special_rich_gain_multiplier", "float", 3, "Rich round in-round gain multiplier", 1, 10),
  // ── misc ────────────────────────────────────────────────────────────────────
  S("sm_ttt_afk_seconds", "int", 180, "Seconds before an unmoved player is moved to spectator (0 = never)", 0, 600),
  S("sm_ttt_show_names", "bool", true, "Show the name of the player you are looking at"),
  // ON by default, unlike the C# (`StripWeaponsPriorToEquipping = false`). The C# could afford that
  // because its rounds ride the engine's own restart, which clears inventories; TTT rounds here begin
  // without one, so anything held simply carried over and players accumulated weapons round on round.
  //
  // Applied when the round ENDS, not when roles are dealt: the pre-round window is when players arm
  // themselves off the map, and stripping at assignment took that away. The knife and any pistol are
  // always kept — see `stripToSidearms`.
  S("sm_ttt_strip_on_assign", "bool", true, "Strip primaries/utility (keep knife + pistol) at round end and on spawn"),
  S("sm_ttt_prop_pickup", "bool", true, "Allow players to carry props and bodies with USE"),
];

/** Raw parsed values, keyed by ConVar name. Written by {@link refresh}, read by the getters. */
const raw = new Map<string, number | boolean | string>();

/** Register every ConVar with the engine. Call once, in the plugin factory. */
export function registerCvars(): void {
  for (let i = 0; i < SPECS.length; i++) {
    const s = SPECS[i]!;
    Server.registerCvar(s.name, {
      type: s.kind === "int" ? "int" : s.kind === "float" ? "float" : s.kind === "bool" ? "bool" : "string",
      default: s.def,
      help: s.help,
      min: s.min,
      max: s.max,
    });
    raw.set(s.name, s.def);
  }
}

function clamp(v: number, s: Spec): number {
  if (s.min !== undefined && v < s.min) return s.min;
  if (s.max !== undefined && v > s.max) return s.max;
  return v;
}

/**
 * Re-read every ConVar into the snapshot. Called at load and at each round transition — NOT per
 * config access, which is the whole point of this module.
 */
export function refresh(): void {
  for (let i = 0; i < SPECS.length; i++) {
    const s = SPECS[i]!;
    const text = Server.getCvar(s.name);
    if (text === "") {
      raw.set(s.name, s.def);
      continue;
    }
    switch (s.kind) {
      case "int": {
        const n = parseInt(text, 10);
        raw.set(s.name, Number.isFinite(n) ? clamp(n, s) : (s.def as number));
        break;
      }
      case "float": {
        const n = parseFloat(text);
        raw.set(s.name, Number.isFinite(n) ? clamp(n, s) : (s.def as number));
        break;
      }
      case "bool":
        raw.set(s.name, text !== "0" && text.toLowerCase() !== "false");
        break;
      default:
        raw.set(s.name, text);
    }
  }
  rebuild();
}

/** A config value as a number. */
export function n(name: string): number {
  return (raw.get(name) as number | undefined) ?? 0;
}
/** A config value as a boolean. */
export function b(name: string): boolean {
  return (raw.get(name) as boolean | undefined) ?? false;
}
/** A config value as a string. */
export function s(name: string): string {
  return (raw.get(name) as string | undefined) ?? "";
}

/** Split a comma-separated ConVar into trimmed, non-empty parts. */
export function list(name: string): string[] {
  const text = s(name);
  if (text === "") return [];
  const out: string[] = [];
  for (const part of text.split(",")) {
    const t = part.trim();
    if (t !== "") out.push(t);
  }
  return out;
}

/**
 * The hot-path config snapshot. Fields most read during a round get a named property here so the
 * access is a plain property load rather than a `Map.get` — everything else goes through
 * {@link n}/{@link b}/{@link s}, which is still orders of magnitude cheaper than the C# original.
 */
export const cfg = {
  countdownSeconds: 15,
  minPlayers: 2,
  timeBetweenRounds: 1,
  postRoundSeconds: 5,
  roundBase: 60,
  roundPerPlayer: 15,
  roundMax: 300,
  afkSeconds: 60,
  showNames: true,
  stripOnAssign: false,
  iconsEnabled: true,
  bodiesEnabled: true,
  bodyHidePawn: true,
  bodySettle: true,
  propPickup: true,
  /** Health by {@link RoleId} index. */
  roleHealth: new Int32Array(5),
  /** Armor by {@link RoleId} index. */
  roleArmor: new Int32Array(5),
  dnaGlow: false,
  roleGlowSeconds: 4,
  roleFlashSeconds: 4,
  rolePanels: false,
  /** Starting weapons by {@link RoleId} index. */
  roleWeapons: [[], [], [], [], []] as string[][],
  /** Starting credits by {@link RoleId} index. */
  roleCredits: new Int32Array(5),
  karmaDefault: 50,
  karmaMin: 0,
  karmaTimeoutThreshold: 20,
  karmaRoundTimeout: 4,
  karmaWarningWindowMs: 86_400_000,
  karmaPerRound: 1,
  karmaPerRoundWin: 1,
};

/** Recompute the derived snapshot fields from {@link raw}. */
function rebuild(): void {
  cfg.countdownSeconds = n("sm_ttt_round_countdown");
  cfg.minPlayers = n("sm_ttt_minimum_players");
  cfg.timeBetweenRounds = n("sm_ttt_time_between_rounds");
  cfg.postRoundSeconds = n("sm_ttt_post_round_seconds");
  cfg.roundBase = n("sm_ttt_round_duration_base");
  cfg.roundPerPlayer = n("sm_ttt_round_duration_per_player");
  cfg.roundMax = n("sm_ttt_round_duration_max");
  cfg.afkSeconds = n("sm_ttt_afk_seconds");
  cfg.showNames = b("sm_ttt_show_names");
  cfg.stripOnAssign = b("sm_ttt_strip_on_assign");
  cfg.iconsEnabled = b("sm_ttt_icons_enabled");
  cfg.bodiesEnabled = b("sm_ttt_bodies_enabled");
  cfg.bodyHidePawn = b("sm_ttt_body_hidepawn");
  cfg.bodySettle = b("sm_ttt_body_settle");
  cfg.propPickup = b("sm_ttt_prop_pickup");

  // RoleId: 1 = Innocent, 2 = Traitor, 3 = Detective.
  cfg.roleHealth[1] = n("sm_ttt_rolehp_innocent");
  cfg.roleHealth[2] = n("sm_ttt_rolehp_traitor");
  cfg.roleHealth[3] = n("sm_ttt_rolehp_detective");
  cfg.roleArmor[1] = n("sm_ttt_rolearmor_innocent");
  cfg.roleArmor[2] = n("sm_ttt_rolearmor_traitor");
  cfg.roleArmor[3] = n("sm_ttt_rolearmor_detective");
  cfg.dnaGlow = b("sm_ttt_dna_glow");
  cfg.roleGlowSeconds = n("sm_ttt_role_glow_seconds");
  cfg.roleFlashSeconds = n("sm_ttt_role_flash_seconds");
  cfg.rolePanels = b("sm_ttt_role_panels");
  cfg.roleWeapons[1] = list("sm_ttt_roleweapons_innocent");
  cfg.roleWeapons[2] = list("sm_ttt_roleweapons_traitor");
  cfg.roleWeapons[3] = list("sm_ttt_roleweapons_detective");
  cfg.roleCredits[1] = n("sm_ttt_shop_start_innocent");
  cfg.roleCredits[2] = n("sm_ttt_shop_start_traitor");
  cfg.roleCredits[3] = n("sm_ttt_shop_start_detective");

  cfg.karmaDefault = n("sm_ttt_karma_default");
  cfg.karmaMin = n("sm_ttt_karma_min");
  cfg.karmaTimeoutThreshold = n("sm_ttt_karma_timeout_threshold");
  cfg.karmaRoundTimeout = n("sm_ttt_karma_round_timeout");
  cfg.karmaWarningWindowMs = n("sm_ttt_karma_warning_window_hours") * 3_600_000;
  cfg.karmaPerRound = n("sm_ttt_karma_per_round");
  cfg.karmaPerRoundWin = n("sm_ttt_karma_per_round_win");
}

/** Round length for a given participant count — the C# `CS2RoundConfig.RoundDuration`. */
export function roundDuration(players: number): number {
  return Math.min(cfg.roundBase + (players - 1) * cfg.roundPerPlayer, cfg.roundMax);
}
