/**
 * The English phrase table — the merged `lang/en.yml` files from the C# tree.
 *
 * Syntax is unchanged from the original so an operator's existing overrides port across:
 *   `%KEY%`   — splice in another phrase (resolved once, at compile time)
 *   `{color}` — a chat colour control byte
 *   `{1}`     — positional argument
 *   `%s%`     — pluralize the preceding word against the preceding number
 *   `%an%`    — "a" or "an", chosen from the following word
 */

export const PHRASES: Readonly<Record<string, string>> = {
  // ── core ──────────────────────────────────────────────────────────────────
  // --- admin command replies -------------------------------------------------
  // Console/rcon output for the sm_ttt_* commands. These were hardcoded English until the move to
  // the SDK translations; they carry no %PREFIX% because they answer in a console, where the chat
  // colour bytes the prefix contains render as garbage.
  /** One name in the Traitor teammate list; the leading spaces are the bullet. */
  ROLE_REVEAL_TRAITORS_ENTRY: " - {1}",

  CMD_MYROLE_SET: "[ttt] you will be {1} next round.",
  CMD_MYROLE_CLEARED: "[ttt] role reservation cleared.",
  CMD_MYROLE_USAGE: "[ttt] usage: sm_ttt_myrole <innocent|traitor|detective|none>",
  CMD_MYROLE_NO_SLOT: "[ttt] that command reserves a role for YOURSELF — run it in-game, not from rcon.",

  CMD_ROUND_STARTING: "Round starting.",
  CMD_ROUND_ENDED: "Round ended.",
  CMD_SPECIAL_AVAILABLE: "Available: {1}",
  CMD_USAGE_KARMA: "[ttt] usage: sm_ttt_karma <slot|name> <value>   (also clears a karma timeout)",
  CMD_USAGE_GIVE: "[ttt] usage: sm_ttt_give <slot|name> <item-id>",
  CMD_NO_PLAYER_MATCH: "[ttt] no connected player matching \"{1}\"",
  CMD_ITEM_LIST: "[ttt] items: {1}",
  CMD_UNKNOWN_ITEM: "[ttt] unknown item \"{1}\" — try sm_ttt_give with no arguments",
  CMD_GAVE_ITEM: "[ttt] gave {1} to {2}",
  CMD_ROLE_SET: "Set slot {1} to {2}.",
  CMD_WORLD_ENTITIES: "[ttt] world entities: point_worldtext={1} prop_ragdoll={2} prop_dynamic={3}",

  PREFIX: "{darkred}T{red}T{lightred}T{grey} | {grey}",
  ROLE_INNOCENT: "{green}Innocent",
  ROLE_DETECTIVE: "{blue}Detective",
  ROLE_TRAITOR: "{red}Traitor",
  ROLE_SPECTATOR: "Spectator",
  ROLE_ASSIGNED: "%PREFIX%You are %an% {1}{grey}!",
  ROLE_REVEAL_DEATH: "%PREFIX%Your killer was %an% {1}{grey}!",
  ROLE_REVEAL_TRAITORS_HEADER: "%PREFIX%Your {red}Traitor {grey}teammates are:",
  ROLE_REVEAL_TRAITORS_NONE: "%PREFIX%You have no {red}Traitor {grey}teammates.",
  GENERIC_UNKNOWN: "%PREFIX%{red}Unknown Command: {darkred}{1}",
  GENERIC_NO_PERMISSION: "%PREFIX%{red}You do not have permission to use this command.",
  GENERIC_PLAYER_ONLY: "%PREFIX%{red}Only players can use this.",
  GENERIC_USAGE: "%PREFIX%Usage: {blue}{1}",
  GENERIC_ERROR: "%PREFIX%{red}An error occurred: {darkred}{1}",
  CMD_TTT: "%PREFIX%Game Version {yellow}{1}",
  GAME_STATE_STARTING: "%PREFIX%{lime}The game is starting in {yellow}{1}{lime} second%s%.",
  GAME_STATE_STARTED:
    "%PREFIX%{lime}Roles assigned! {grey}There {1} {darkred}{2}{red} %ROLE_TRAITOR%%s% {grey}and {green}{3} {lime}non-%ROLE_TRAITOR%%s%{grey}.",
  GAME_STATE_ENDED_TEAM_WON: "%PREFIX%{darkblue}GAME! {default}{1}s {default}won the game!",
  GAME_STATE_ENDED_OTHER: "%PREFIX%{blue}GAME! {default}{1}{grey}.",
  NOT_ENOUGH_PLAYERS:
    "%PREFIX%{red}Game was canceled due to having fewer than {yellow}{1}{red} player%s%.",
  BODY_IDENTIFIED:
    "%PREFIX%{default}{1}{grey} identified the body of {blue}{2}{grey}, they were %an% {3}{grey}!",
  GAME_LOGS_HEADER: "---------- Game Logs ----------",
  GAME_LOGS_FOOTER: "-------------------------------",
  GAME_LOGS_NONE: "%PREFIX%There is no game active.",
  LOGS_VIEWED_ALIVE: "%PREFIX%{red}{1}{grey} viewed the logs while alive.",

  // --- RDM: the victim prompt, the report, the admin notice ------------------
  // A suspicious kill asks the VICTIM a question rather than accusing anyone. The wording matters:
  // "was this RDM?" invites a reflex yes, so both options state what they mean in full.
  RDM_ASK_TITLE: "%PREFIX%{red}Were you RDM'd by {yellow}{1}{red}?",
  RDM_ASK_YES: "%PREFIX%{grey}Type {green}!rdmyes{grey} - yes, this was RDM",
  RDM_ASK_NO: "%PREFIX%{grey}Type {yellow}!rdmno{grey} - no, that was a good kill",
  RDM_ASK_CONTEXT: "%PREFIX%{grey}Type in chat what {yellow}{1}{grey} did. Your next message is sent to the admins (or type {yellow}cancel{grey}).",
  RDM_ASK_DISMISSED: "%PREFIX%{grey}No report filed.",
  RDM_ASK_EXPIRED: "%PREFIX%{grey}Report timed out - nothing was sent.",
  RDM_FILE_OK: "%PREFIX%{green}Report filed against {yellow}{1}{green}. An admin will review it.",
  RDM_FILE_DUPLICATE: "%PREFIX%{grey}You already have a pending report against {1}.",
  RDM_FILE_RATE_LIMITED: "%PREFIX%{grey}Report limit reached ({1} per round).",
  RDM_FILE_FAILED: "%PREFIX%{red}That report could not be filed.",
  RDM_ADMIN_NEW: "%PREFIX%{yellow}New RDM report: {red}{1}{yellow} vs {red}{2}{yellow} - {grey}!rdm{yellow} to review.",
  RDM_SANCTION_SERVED: "%PREFIX%{red}{1}{grey} was slain for RDM.",
  RDM_SANCTION_BENCHED: "%PREFIX%{grey}You are serving an RDM slay this round and were not given a role.",
  RDM_BAN_CONFIRM: "%PREFIX%{red}Press Ban again to confirm banning {1}.",
  LOGS_VIEWED_INFO: "%PREFIX%Logs printed to console. All players' roles have been shown.",

  // ── CS2 layer ─────────────────────────────────────────────────────────────
  TRAITOR_CHAT_FORMAT: "{darkred}[TRAITORS] {red}{1}: {default}{2}",
  DEAD_CHAT_FORMAT: "{grey}*DEAD* {default}{1}{grey}: {default}{2}",
  TASER_SCANNED: "%PREFIX%You scanned {1}{grey}, they are %an% {2}{grey}!",
  DNA_PREFIX: "{darkblue}D{blue}N{lightblue}A{grey} | {grey}",
  AFK_WARNING: "%PREFIX%You will be moved to spectators in {yellow}{1} second%s%{grey} for being AFK.",
  AFK_MOVED: "%PREFIX%You were moved to spectators for being AFK.",
  LATE_JOIN_SPECTATE:
    "%PREFIX%A round is already in progress — you will join at the start of the next one.",
  DEAD_MUTE_REMINDER: "%PREFIX%You are dead and cannot be heard.",

  // ── shop ──────────────────────────────────────────────────────────────────
  SHOP_PREFIX: "{green}SHOP {grey}| ",
  SHOP_INACTIVE: "%SHOP_PREFIX%The shop is currently closed.",
  SHOP_ITEM_NOT_FOUND: '%SHOP_PREFIX%Could not find an item named "{default}{1}{grey}".',
  SHOP_EXPLORATION: "Exploration",
  SHOP_INSUFFICIENT_BALANCE:
    "%SHOP_PREFIX%You cannot afford {white}{1}{grey}, it costs {yellow}{2}{grey} %CREDITS_NAME%%s%, and you have {yellow}{3}{grey}.",
  SHOP_CANNOT_PURCHASE: "%SHOP_PREFIX%You cannot purchase this item.",
  SHOP_CANNOT_PURCHASE_WITH_REASON: "%SHOP_PREFIX%You cannot purchase this item: {red}{1}{grey}.",
  SHOP_PURCHASED: "%SHOP_PREFIX%You purchased {white}{1}{grey}.",
  SHOP_PURCHASED_DETAIL: "%SHOP_PREFIX%{white}{1}{grey}.",
  SHOP_LIST_FOOTER:
    "%SHOP_PREFIX%You are %an% {1}{grey}, you have {yellow}{2}{grey} %CREDITS_NAME%%s%.",
  SHOP_REFUNDED: "Refunded: {1}",
  SHOP_MENU_TITLE: "Shop",
  SHOP_CONFIRM_TITLE: "Buy {1} for {2}?",
  SHOP_CONFIRM_YES: "Yes, buy it",
  SHOP_CONFIRM_NO: "No, go back",
  SHOP_MENU_CLOSED:
    "%SHOP_PREFIX%Shop closed — {yellow}ping{grey} or type {yellow}!shop{grey} to open it again.",
  SHOP_MENU_EXPIRED:
    "%SHOP_PREFIX%Shop timed out — {yellow}ping{grey} or type {yellow}!shop{grey} to open it again.",
  CREDITS_NAME: "point",
  CREDITS_GIVEN: "%SHOP_PREFIX%{1}{2} %CREDITS_NAME%%s%",
  CREDITS_GIVEN_REASON: "%SHOP_PREFIX%{1}{2} %CREDITS_NAME%%s% {grey}({white}{3}{grey})",
  COMMAND_BALANCE: "%SHOP_PREFIX%You have {yellow}{1}{grey} %CREDITS_NAME%%s%.",

  // ── shop items ────────────────────────────────────────────────────────────
  SHOP_ITEM_ARMOR: "Armor with Helmet",
  SHOP_ITEM_ARMOR_DESC: "Body armor and a helmet",
  SHOP_ITEM_TASER: "Taser",
  SHOP_ITEM_TASER_DESC: "Tasing a player will tell you their role",
  SHOP_ITEM_HEALTHSHOT: "Healthshot",
  SHOP_ITEM_HEALTHSHOT_DESC: "Heals you when used",
  SHOP_ITEM_M4A1: "M4A1 Rifle and USP-S",
  SHOP_ITEM_M4A1_DESC: "A rifle and a silenced pistol",
  SHOP_ITEM_DEAGLE: "One-Hit Revolver",
  SHOP_ITEM_DEAGLE_DESC:
    "If you hit an enemy, they will die instantly. Hitting a teammate will kill you instead",
  SHOP_ITEM_DEAGLE_HIT_FF: "%PREFIX%You hit a teammate!",
  SHOP_ITEM_DEAGLE_VICTIM: "%PREFIX%You were hit by a {yellow}One-Hit Revolver{grey}.",
  SHOP_ITEM_STICKERS: "Stickers",
  SHOP_ITEM_STICKERS_DESC: "When you tase a player, their role will be shown to everyone",
  SHOP_ITEM_STICKERS_HIT:
    "%SHOP_PREFIX%You got {green}stickered{grey}, your role is now visible to everyone.",
  SHOP_ITEM_C4: "C4 Explosive",
  SHOP_ITEM_C4_DESC:
    "The bomb will deal damage to everyone including you and fellow {red}Traitors{grey}",
  SHOP_ITEM_GLOVES: "Gloves",
  SHOP_ITEM_GLOVES_DESC:
    "You can now kill without leaving DNA behind, or move bodies without IDing them",
  SHOP_ITEM_GLOVES_USED_BODY:
    "%SHOP_PREFIX%You used your gloves to move a body without leaving DNA. ({yellow}{1}{grey}/{yellow}{2}{grey} use%s% left).",
  SHOP_ITEM_GLOVES_USED_KILL:
    "%SHOP_PREFIX%You used your gloves to kill without leaving DNA evidence. ({yellow}{1}{grey}/{yellow}{2}{grey} use%s% left).",
  SHOP_ITEM_GLOVES_WORN_OUT: "%SHOP_PREFIX%Your gloves wore out.",
  SHOP_ITEM_DNA: "DNA Scanner",
  SHOP_ITEM_DNA_DESC: "Scan bodies to reveal the person who killed them",
  SHOP_ITEM_DNA_SCANNED:
    "%DNA_PREFIX%You scanned {1}{2}'%s% {grey}body, their killer was {red}{3}{grey}.",
  SHOP_ITEM_DNA_SCANNED_OTHER: "%DNA_PREFIX%You scanned {1}{2}'%s% {grey}body, {3}.",
  SHOP_ITEM_DNA_EXPIRED: "%DNA_PREFIX%You scanned {1}{2}'%s% {grey}body, but the DNA has expired.",
  // The scan no longer NAMES the killer — it hands over a trace to follow. Identifying whoever left
  // it is the Detective's job, and the point of the item.
  SHOP_ITEM_DNA_TRACE: "%DNA_PREFIX%You recovered a trace from {1}{2}'%s% {grey}body. Find whoever left it.",
  DNA_TRACK_SEARCHING: "Searching for a match...",
  DNA_TRACK_ATTEMPTING: "Attempting to identify killer...",
  DNA_TRACK_ALMOST: "Almost there...",
  DNA_TRACK_IDENTIFYING: "Identifying...",
  DNA_TRACK_IDENTIFIED: "Killer identified: {1}",
  SHOP_ITEM_STATION_HEALTH: "Health Station",
  SHOP_ITEM_STATION_HEALTH_DESC: "The health station will heal all players around it",
  SHOP_ITEM_STATION_HURT: "Hurt Station",
  SHOP_ITEM_STATION_HURT_DESC: "The hurt station will damage all non-Traitors around it",
  SHOP_ITEM_CAMO: "Camouflage",
  SHOP_ITEM_CAMO_DESC: "You are now harder to see",
  SHOP_ITEM_BODY_PAINT: "Body Paint",
  SHOP_ITEM_BODY_PAINT_DESC:
    "Interacting with bodies will now paint them, making them appear identified",
  SHOP_ITEM_BODY_PAINT_OUT: "%PREFIX%You ran out of body paint.",
  SHOP_ITEM_POISON_SHOTS: "Poison Shots",
  SHOP_ITEM_POISON_SHOTS_DESC: "The next 5 shots from your {red}pistols{grey} are coated with poison",
  SHOP_ITEM_POISON_HIT: "%PREFIX%You hit {green}{1}{grey} with a {lightpurple}poison shot{grey}.",
  SHOP_ITEM_POISON_OUT: "%PREFIX%You are out of poison shots.",
  SHOP_ITEM_POISON_SMOKE: "Poison Smoke",
  SHOP_ITEM_POISON_SMOKE_DESC:
    "The smoke grenade will damage all non-Traitors inside it over time",
  SHOP_ITEM_ONE_HIT_KNIFE: "One-Hit Knife",
  SHOP_ITEM_ONE_HIT_KNIFE_DESC: "Your {red}next knife{grey} attack will instantly kill your target",
  SHOP_ITEM_COMPASS_PLAYER: "Player Compass",
  SHOP_ITEM_COMPASS_PLAYER_DESC: "Shows the direction of nearby players",
  SHOP_ITEM_COMPASS_BODY: "Body Compass",
  SHOP_ITEM_COMPASS_BODY_DESC: "Shows the direction of nearby bodies",
  SHOP_ITEM_SILENT_AWP: "Silent AWP",
  SHOP_ITEM_SILENT_AWP_DESC: "An AWP that makes no sound when fired",
  SHOP_ITEM_CLUSTER_GRENADE: "Cluster Grenade",
  SHOP_ITEM_CLUSTER_GRENADE_DESC: "Splits into several grenades on detonation",
  SHOP_ITEM_TRIPWIRE: "Tripwire",
  SHOP_ITEM_TRIPWIRE_DESC: "The tripwire will activate once anyone crosses it",
  SHOP_ITEM_TRIPWIRE_TOOFAR: "%PREFIX%You are too far away to place the tripwire.",
  SHOP_ITEM_TRIPWIRE_ARMED:
    "%PREFIX%Tripwire ready — press {yellow}E{grey} to place it. You are carrying {yellow}{1}{grey}.",
  SHOP_ITEM_TRIPWIRE_PLACED: "%PREFIX%Tripwire placed. {yellow}{1}{grey} left.",
  SHOP_ITEM_TRIPWIRE_PLACED_LAST: "%PREFIX%Tripwire placed. That was your last one.",
  SHOP_ITEM_TRIPWIRE_DEFUSING: "Defusing... ({1}, {2} second%s% left).",
  SHOP_ITEM_TRIPWIRE_DEFUSING_CANCELED: "%PREFIX%You stopped defusing the tripwire.",

  // ── karma ─────────────────────────────────────────────────────────────────
  KARMA_COMMAND: "%PREFIX%You have {yellow}{1}{grey} karma.",
  KARMA_WARNING:
    "%PREFIX%You have {red}very low{grey} karma, and have been forced to sit out for {yellow}{1} {grey}round%s%. Please make sure you read our rules!",

  // ── special rounds ────────────────────────────────────────────────────────
  SPECIAL_ROUND_STARTED:
    "%PREFIX%This round is a {purple}Special Round{grey}! This round is a {lightpurple}{1}{grey} round!",
  SPECIAL_ROUND_SPEED:
    " {yellow}SPEED{grey}: The round is faster than usual! {red}Traitors{grey} must kill to gain more time.",
  SPECIAL_ROUND_BHOP: " {yellow}BHOP{grey}: Bunny hopping is enabled! Hold jump to move faster!",
  SPECIAL_ROUND_VANILLA: " {green}VANILLA{grey}: The shop has been disabled!",
  SPECIAL_ROUND_SUPPRESSED: " {grey}SUPPRESSED{grey}: All pistols are silent!",
  SPECIAL_ROUND_PISTOL: " {blue}PISTOL{grey}: You can only use pistols this round!",
  SPECIAL_ROUND_RICH: " {gold}RICH{grey}: All players start with extra credits!",
  SPECIAL_ROUND_LOWGRAV:
    " {lightblue}LOW GRAVITY{grey}: Players can jump higher and fall slower!",
  VANILLA_ROUND_REMINDER: "%SHOP_PREFIX%This is a {purple}Vanilla{grey} round. The shop is disabled.",
};
