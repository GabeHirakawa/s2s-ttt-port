/**
 * The round action log — the port of `IActionLogger` / `SimpleLogger` / the `IAction` classes.
 *
 * The C# logger stored actions in a `SortedDictionary<DateTime, ISet<IAction>>` and rebuilt each
 * line by calling `IAction.Format()`, which re-read the actor's role out of the role dictionary and
 * ran `Name.First(char.IsAsciiLetter)` per line. It also allocated an `IAction` object (each pulling
 * roles from the DI container in its constructor) for every damage tick — several per second per
 * shooting player.
 *
 * Here an entry is a flat record in a preallocated ring buffer with the strings resolved at the
 * moment of the action, and damage entries are coalesced: repeated hits from the same attacker on
 * the same victim with the same weapon accumulate into one line instead of spamming the log.
 */

import { Clients } from "@s2script/sdk/clients";
import { Server } from "@s2script/sdk/server";
import { RoleId } from "../core/enums";
import { msg } from "../core/msgs";
import * as reg from "../core/registry";

/** How many entries a single round retains. Beyond this the oldest are dropped. */
const CAPACITY = 512;

const enum Kind {
  Death = 0,
  Damage = 1,
  Identify = 2,
  RoleAssigned = 3,
  Purchase = 4,
}

interface Entry {
  kind: Kind;
  /** Seconds since the round started. */
  at: number;
  actor: string;
  actorRole: RoleId;
  other: string;
  otherRole: RoleId;
  detail: string;
  /** Accumulated damage for a coalesced damage entry. */
  amount: number;
  /** True when the pairing is "bad" (same team) — rendered with a [BAD] marker. */
  bad: boolean;
}

const entries: Entry[] = [];
let epochTime = 0;

/** Drop every entry and re-base the clock. Called at round start. */
export function clearLog(): void {
  entries.length = 0;
  epochTime = Server.gameTime;
}

/** One-letter role tag, as the C# `Name.First(char.IsAsciiLetter)` produced. */
function tag(role: RoleId): string {
  switch (role) {
    case RoleId.Innocent: return " [I]";
    case RoleId.Traitor: return " [T]";
    case RoleId.Detective: return " [D]";
    default: return "";
  }
}

/** A padded `(id) name` label, matching the original's fixed-width log alignment. */
function label(slot: number): string {
  const name = reg.nameOf(slot);
  const id = reg.steamIdOf(slot);
  const suffix = id.length > 5 ? id.slice(-5) : id.padStart(5, "0");
  const prefix = `(${suffix})`;
  const width = 24;
  const base = `${prefix} ${name}`;
  if (base.length >= width) return `${prefix} ${name.slice(0, Math.max(0, width - prefix.length - 1))}`;
  return prefix + " ".repeat(width - prefix.length - name.length) + name;
}

function push(e: Entry): void {
  if (entries.length >= CAPACITY) entries.shift();
  entries.push(e);
}

/** True when both parties are on the same side — a "bad" action in TTT terms. */
function sameTeam(a: RoleId, b: RoleId): boolean {
  return (a === RoleId.Traitor) === (b === RoleId.Traitor);
}

/** Record a kill. */
export function logDeath(victim: number, killer: number, weapon: string): void {
  const vRole = reg.roleOf(victim);
  const kRole = killer >= 0 ? reg.roleOf(killer) : RoleId.None;
  push({
    kind: Kind.Death,
    at: Server.gameTime - epochTime,
    actor: killer >= 0 ? label(killer) : label(victim),
    actorRole: killer >= 0 ? kRole : vRole,
    other: killer >= 0 ? label(victim) : "",
    otherRole: killer >= 0 ? vRole : RoleId.None,
    detail: weapon === "" ? "" : `using ${weapon}`,
    amount: 0,
    bad: killer >= 0 && sameTeam(kRole, vRole),
  });
}

/**
 * Record damage, coalescing into the most recent matching entry. The C# logged every single hit;
 * an automatic weapon burst produced a dozen near-identical lines and a dozen allocations.
 */
export function logDamage(victim: number, attacker: number, weapon: string, amount: number): void {
  const aLabel = label(attacker);
  const vLabel = label(victim);
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - 4; i--) {
    const e = entries[i]!;
    if (e.kind === Kind.Damage && e.actor === aLabel && e.other === vLabel && e.detail === weapon) {
      e.amount += amount;
      return;
    }
  }
  const aRole = reg.roleOf(attacker);
  const vRole = reg.roleOf(victim);
  push({
    kind: Kind.Damage,
    at: Server.gameTime - epochTime,
    actor: aLabel,
    actorRole: aRole,
    other: vLabel,
    otherRole: vRole,
    detail: weapon,
    amount,
    bad: sameTeam(aRole, vRole),
  });
}

/** Record a body identification. */
export function logIdentify(identifier: number, ownerName: string, ownerRole: RoleId): void {
  push({
    kind: Kind.Identify,
    at: Server.gameTime - epochTime,
    actor: label(identifier),
    actorRole: reg.roleOf(identifier),
    other: ownerName,
    otherRole: ownerRole,
    detail: "",
    amount: 0,
    bad: false,
  });
}

/** Record a role assignment. */
export function logRoleAssigned(slot: number, role: RoleId, name: string): void {
  push({
    kind: Kind.RoleAssigned,
    at: Server.gameTime - epochTime,
    actor: label(slot),
    actorRole: role,
    other: "",
    otherRole: RoleId.None,
    detail: name,
    amount: 0,
    bad: false,
  });
}

/** Record a shop purchase. */
export function logPurchase(slot: number, itemName: string): void {
  push({
    kind: Kind.Purchase,
    at: Server.gameTime - epochTime,
    actor: label(slot),
    actorRole: reg.roleOf(slot),
    other: "",
    otherRole: RoleId.None,
    detail: itemName,
    amount: 0,
    bad: false,
  });
}

/** `[MM:SS]` since round start. */
function stamp(at: number): string {
  const total = at < 0 ? 0 : at | 0;
  const m = (total / 60) | 0;
  const s = total % 60;
  return `[${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}]`;
}

/** Render one entry to its log line. */
function render(e: Entry): string {
  const bad = e.bad ? "[BAD] " : "";
  const a = e.actor + tag(e.actorRole);
  switch (e.kind) {
    case Kind.Death:
      return e.other === ""
        ? `${stamp(e.at)} ${bad}${a} died ${e.detail}`
        : `${stamp(e.at)} ${bad}${a} killed ${e.other}${tag(e.otherRole)} ${e.detail}`;
    case Kind.Damage:
      return `${stamp(e.at)} ${bad}${a} damaged ${e.other}${tag(e.otherRole)} for ${e.amount} damage with ${e.detail}`;
    case Kind.Identify:
      return `${stamp(e.at)} ${a} identified the body of ${e.other}${tag(e.otherRole)}`;
    case Kind.RoleAssigned:
      return `${stamp(e.at)} ${a} was assigned ${e.detail}`;
    default:
      return `${stamp(e.at)} ${a} purchased ${e.detail}`;
  }
}

/** Build the full log as lines (header + entries + footer). */
export function makeLogs(): string[] {
  const out: string[] = [msg("GAME_LOGS_HEADER")];
  for (let i = 0; i < entries.length; i++) out.push(render(entries[i]!));
  out.push(msg("GAME_LOGS_FOOTER"));
  return out;
}

/** Print the log to every player's developer console, and once to the server console. */
export function printLogs(): void {
  const lines = makeLogs();
  const active = reg.activeSlots();
  for (let i = 0; i < active.length; i++) {
    const client = Clients.fromSlot(active[i]!);
    if (client === null || client.isBot) continue;
    for (let j = 0; j < lines.length; j++) client.print(lines[j]!);
  }
  for (let j = 0; j < lines.length; j++) console.log(lines[j]!);
}

/** Print the log to a single player's developer console (the `!logs` command). */
export function printLogsTo(slot: number): void {
  const lines = makeLogs();
  const client = slot < 0 ? null : Clients.fromSlot(slot);
  if (client === null) {
    for (let j = 0; j < lines.length; j++) console.log(lines[j]!);
    return;
  }
  for (let j = 0; j < lines.length; j++) client.print(lines[j]!);
}

