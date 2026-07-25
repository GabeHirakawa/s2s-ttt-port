/**
 * The English phrase table — the merged `lang/en.yml` files from the C# tree.
 *
 * Syntax is unchanged from the original so an operator's existing overrides port across:
 *   `%KEY%`   — splice in another phrase (resolved once, at compile time)
 *   `{color}` — a chat colour control byte
 *   `{0}`     — positional argument
 *   `%s%`     — pluralize the preceding word against the preceding number
 *   `%an%`    — "a" or "an", chosen from the following word
 */

export const PHRASES: Readonly<Record<string, string>> = {
  // ── core ──────────────────────────────────────────────────────────────────
  PREFIX: "{darkred}T{red}T{lightred}T{grey} | {grey}",
  ROLE_INNOCENT: "{green}Innocent",
  ROLE_DETECTIVE: "{blue}Detective",
  ROLE_TRAITOR: "{red}Traitor",
  ROLE_SPECTATOR: "Spectator",
  ROLE_ASSIGNED: "%PREFIX%You are %an% {0}{grey}!",
  ROLE_REVEAL_DEATH: "%PREFIX%Your killer was %an% {0}{grey}!",
  ROLE_REVEAL_TRAITORS_HEADER: "%PREFIX%Your {red}Traitor {grey}teammates are:",
  ROLE_REVEAL_TRAITORS_NONE: "%PREFIX%You have no {red}Traitor {grey}teammates.",
  GENERIC_UNKNOWN: "%PREFIX%{red}Unknown Command: {darkred}{0}",
  GENERIC_NO_PERMISSION: "%PREFIX%{red}You do not have permission to use this command.",
  GENERIC_PLAYER_ONLY: "%PREFIX%{red}Only players can use this.",
  GENERIC_USAGE: "%PREFIX%Usage: {blue}{0}",
  GENERIC_ERROR: "%PREFIX%{red}An error occurred: {darkred}{0}",
  CMD_TTT: "%PREFIX%Game Version {yellow}{0}",
  GAME_STATE_STARTING: "%PREFIX%{lime}The game is starting in {yellow}{0}{lime} second%s%.",
  GAME_STATE_STARTED:
    "%PREFIX%{lime}Roles assigned! {grey}There {0} {darkred}{1}{red} %ROLE_TRAITOR%%s% {grey}and {green}{2} {lime}non-%ROLE_TRAITOR%%s%{grey}.",
  GAME_STATE_ENDED_TEAM_WON: "%PREFIX%{darkblue}GAME! {default}{0}s {default}won the game!",
  GAME_STATE_ENDED_OTHER: "%PREFIX%{blue}GAME! {default}{0}{grey}.",
  NOT_ENOUGH_PLAYERS:
    "%PREFIX%{red}Game was canceled due to having fewer than {yellow}{0}{red} player%s%.",
  BODY_IDENTIFIED:
    "%PREFIX%{default}{0}{grey} identified the body of {blue}{1}{grey}, they were %an% {2}{grey}!",
  GAME_LOGS_HEADER: "---------- Game Logs ----------",
  GAME_LOGS_FOOTER: "-------------------------------",
  GAME_LOGS_NONE: "%PREFIX%There is no game active.",
  LOGS_VIEWED_ALIVE: "%PREFIX%{red}{0}{grey} viewed the logs while alive.",
  LOGS_VIEWED_INFO: "%PREFIX%Logs printed to console. All players' roles have been shown.",

  // ── CS2 layer ─────────────────────────────────────────────────────────────
  TRAITOR_CHAT_FORMAT: "{darkred}[TRAITORS] {red}{0}: {default}{1}",
  TASER_SCANNED: "%PREFIX%You scanned {0}{grey}, they are %an% {1}{grey}!",
  DNA_PREFIX: "{darkblue}D{blue}N{lightblue}A{grey} | {grey}",
  AFK_WARNING: "%PREFIX%You will be moved to spectators in {yellow}{0} second%s%{grey} for being AFK.",
  AFK_MOVED: "%PREFIX%You were moved to spectators for being AFK.",
  LATE_JOIN_SPECTATE:
    "%PREFIX%A round is already in progress — you will join at the start of the next one.",
  DEAD_MUTE_REMINDER: "%PREFIX%You are dead and cannot be heard.",

  // ── shop ──────────────────────────────────────────────────────────────────
  SHOP_PREFIX: "{green}SHOP {grey}| ",
  SHOP_INACTIVE: "%SHOP_PREFIX%The shop is currently closed.",
  SHOP_ITEM_NOT_FOUND: '%SHOP_PREFIX%Could not find an item named "{default}{0}{grey}".',
  SHOP_EXPLORATION: "Exploration",
  SHOP_INSUFFICIENT_BALANCE:
    "%SHOP_PREFIX%You cannot afford {white}{0}{grey}, it costs {yellow}{1}{grey} %CREDITS_NAME%%s%, and you have {yellow}{2}{grey}.",
  SHOP_CANNOT_PURCHASE: "%SHOP_PREFIX%You cannot purchase this item.",
  SHOP_CANNOT_PURCHASE_WITH_REASON: "%SHOP_PREFIX%You cannot purchase this item: {red}{0}{grey}.",
  SHOP_PURCHASED: "%SHOP_PREFIX%You purchased {white}{0}{grey}.",
  SHOP_PURCHASED_DETAIL: "%SHOP_PREFIX%{white}{0}{grey}.",
  SHOP_LIST_FOOTER:
    "%SHOP_PREFIX%You are %an% {0}{grey}, you have {yellow}{1}{grey} %CREDITS_NAME%%s%.",
  CREDITS_NAME: "point",
  CREDITS_GIVEN: "%SHOP_PREFIX%{0}{1} %CREDITS_NAME%%s%",
  CREDITS_GIVEN_REASON: "%SHOP_PREFIX%{0}{1} %CREDITS_NAME%%s% {grey}({white}{2}{grey})",
  COMMAND_BALANCE: "%SHOP_PREFIX%You have {yellow}{0}{grey} %CREDITS_NAME%%s%.",

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
    "%SHOP_PREFIX%You used your gloves to move a body without leaving DNA. ({yellow}{0}{grey}/{yellow}{1}{grey} use%s% left).",
  SHOP_ITEM_GLOVES_USED_KILL:
    "%SHOP_PREFIX%You used your gloves to kill without leaving DNA evidence. ({yellow}{0}{grey}/{yellow}{1}{grey} use%s% left).",
  SHOP_ITEM_GLOVES_WORN_OUT: "%SHOP_PREFIX%Your gloves wore out.",
  SHOP_ITEM_DNA: "DNA Scanner",
  SHOP_ITEM_DNA_DESC: "Scan bodies to reveal the person who killed them",
  SHOP_ITEM_DNA_SCANNED:
    "%DNA_PREFIX%You scanned {0}{1}'%s% {grey}body, their killer was {red}{2}{grey}.",
  SHOP_ITEM_DNA_SCANNED_OTHER: "%DNA_PREFIX%You scanned {0}{1}'%s% {grey}body, {2}.",
  SHOP_ITEM_DNA_EXPIRED: "%DNA_PREFIX%You scanned {0}{1}'%s% {grey}body, but the DNA has expired.",
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
  SHOP_ITEM_POISON_HIT: "%PREFIX%You hit {green}{0}{grey} with a {lightpurple}poison shot{grey}.",
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
  SHOP_ITEM_TRIPWIRE_DEFUSING: "Defusing... ({0}, {1} second%s% left).",
  SHOP_ITEM_TRIPWIRE_DEFUSING_CANCELED: "%PREFIX%You stopped defusing the tripwire.",

  // ── karma ─────────────────────────────────────────────────────────────────
  KARMA_COMMAND: "%PREFIX%You have {yellow}{0}{grey} karma.",
  KARMA_WARNING:
    "%PREFIX%You have {red}very low{grey} karma, and have been forced to sit out for {yellow}{0} {grey}round%s%. Please make sure you read our rules!",

  // ── special rounds ────────────────────────────────────────────────────────
  SPECIAL_ROUND_STARTED:
    "%PREFIX%This round is a {purple}Special Round{grey}! This round is a {lightpurple}{0}{grey} round!",
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
