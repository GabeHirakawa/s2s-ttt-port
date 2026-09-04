/**
 * The message formatter — the port of `TTT.Locale.StringLocalizer`.
 *
 * The C# version re-did all of this on EVERY formatted message: a `%.*?%` regex sweep with a
 * localizer dictionary lookup per match, `string.Format`, a `\b(\w+)%s%` regex for pluralization
 * (which then split the whole prefix on spaces and re-parsed integers), an `%an%` regex, and a
 * final full-string scan for control bytes. Messages fire constantly — role reveals, credit
 * grants, kill feed, log dumps — so this was real per-frame work.
 *
 * Here each phrase is COMPILED ONCE at load into a chunk list:
 *   - `%KEY%` splices are resolved and inlined,
 *   - `{color}` tokens are replaced with their control byte,
 *   - `{0}` markers become argument slots,
 *   - and each phrase records whether it needs the `%s%` / `%an%` passes at all.
 *
 * Formatting is then a `join` over precomputed chunks, with the two grammar passes running only
 * for the minority of phrases that actually contain those markers.
 *
 * LOOKUP AND LANGUAGE BELONG TO THE SDK. `Translations` owns the phrase set, the per-language
 * override files (`translations/<code>/ttt.phrases.json`) and picking a client's language; this file
 * no longer keeps its own table. What stays here is the part the SDK does not do: `%KEY%` splices
 * (52 phrases), `{colour}` tokens (55), and the `%s%`/`%an%` grammar passes (21).
 *
 * The SDK is asked for the TEMPLATE only — `translate(slot, key)` with no args — because argument
 * substitution here is `{0}`-based and interacts with the grammar passes, while the SDK's is
 * `{1}`-based. Handing it args would substitute them before `%s%` could see the number it needs to
 * agree with.
 *
 * The compile cache is therefore keyed by TEMPLATE, not by key: two languages give two templates,
 * and a phrase shared across languages compiles once.
 */

import { ChatColors } from "@s2script/cs2";
import { Translations } from "@s2script/sdk/translations";
import { PHRASES } from "./phrases";

/** The phrase-set name the SDK registers us under; also the `translations/<code>/<NAME>.phrases.json` stem. */
const SET = "ttt";

/**
 * Args that make `Translations.translate` hand back the TEMPLATE rather than a formatted string.
 *
 * The SDK's formatter is unconditional: it rewrites every `{n}` to `args[n-1]`, or to "" when that
 * argument is missing. Calling `translate(slot, key)` with no args therefore ERASES every
 * placeholder — which silently blanked every parameterised message in this mode until it was caught
 * by `sm_ttt_special` printing "Available:" with the list gone.
 *
 * Substituting each `{n}` with the literal text `{n}` is the identity transform, so the template
 * survives intact and this file keeps doing its own substitution — which it must, because `%s%`
 * pluralises against the number that precedes it and the `{colour}`/`%KEY%` compile step is cached
 * per template.
 *
 * Sized past the highest slot any phrase uses; a phrase referencing a higher one would lose it, so
 * that ceiling is asserted rather than trusted.
 */
// Round-trip markers for {@link lookup}.
//
// We ask the SDK for the phrase in the player's language but do the argument substitution HERE,
// because a phrase carries colour tags and grammar tokens the SDK knows nothing about. The way to
// get the template back is to pass a placeholder per slot and recognise it on the way out.
//
// Those placeholders must NOT contain braces. The host strips `{` and `}` from every substituted
// value so a player named `{red}evil` cannot inject a colour tag into everyone's chat — a guard
// worth having, and one that silently turned our old `"{1}"` markers into a bare `1`. That is
// where "Alice identified the body of Bob" became "1 identified the body of 2".
//
// U+E000.. is a Private Use Area codepoint: it survives the brace strip, cannot collide with a
// colour control byte, and will never occur in a real phrase or a player name we care about.
const ARG_MARK = "\uE000";
const TEMPLATE_ARGS: readonly string[] = [1, 2, 3, 4, 5, 6, 7, 8].map(
  (n) => `${ARG_MARK}${String(n)}${ARG_MARK}`,
);
/** Turn the markers back into the `{N}` form {@link compile} understands. */
const RESTORE_MARKS = new RegExp(`${ARG_MARK}(\\d+)${ARG_MARK}`, "g");

/** `{token}` → chat colour control byte. Unknown tokens are left untouched. */
const COLORS: Readonly<Record<string, string>> = {
  default: ChatColors.Default,
  white: ChatColors.White,
  darkred: ChatColors.DarkRed,
  red: ChatColors.Red,
  lightred: ChatColors.LightRed,
  purple: ChatColors.Purple,
  lightpurple: ChatColors.LightPurple,
  magenta: ChatColors.Purple,
  green: ChatColors.Green,
  olive: ChatColors.Olive,
  lime: ChatColors.Lime,
  grey: ChatColors.Grey,
  gray: ChatColors.Grey,
  yellow: ChatColors.Yellow,
  gold: ChatColors.Orange,
  orange: ChatColors.Orange,
  silver: ChatColors.Silver,
  blue: ChatColors.Blue,
  lightblue: ChatColors.Blue,
  darkblue: ChatColors.DarkBlue,
  bluegrey: ChatColors.BlueGrey,
};

/**
 * A compiled phrase. `parts[i]` is emitted, then argument `slots[i]` (when >= 0), alternating.
 * `needsGrammar` is false for the ~70% of phrases with no `%s%`/`%an%`, letting `format` return the
 * joined string directly.
 */
interface Compiled {
  parts: string[];
  slots: number[];
  needsGrammar: boolean;
}

/** Compiled phrases, keyed by the raw TEMPLATE so each language's variant caches independently. */
const compiled = new Map<string, Compiled>();
/** The seed set, kept only to resolve `%KEY%` splices — the SDK owns the per-language lookup. */
let seed: Record<string, string> = PHRASES as Record<string, string>;

/** Replace every `{color}` token with its control byte. */
function applyColors(text: string): string {
  if (text.indexOf("{") < 0) return text;
  return text.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    const c = COLORS[name.toLowerCase()];
    return c === undefined ? whole : c;
  });
}

/**
 * Resolve `%KEY%` splices. Mirrors the original's quirk: a spliced value is left-trimmed unless the
 * key contains "PREFIX" (CounterStrikeSharp forces a leading space onto an all-colour string, which
 * the original stripped everywhere except prefixes).
 */
function expand(text: string, depth: number, slot: number): string {
  if (depth > 8 || text.indexOf("%") < 0) return text;
  return text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, key: string) => {
    // %s% and %an% are grammar markers, not splices — leave them for the runtime pass.
    if (key === "s" || key.toLowerCase() === "an") return whole;
    // Resolve the spliced phrase for the SAME viewer, so a translated phrase splices translated
    // parts rather than English ones. Falls back to the seed for a key the SDK does not know.
    const value = lookup(slot, key) ?? seed[key];
    if (value === undefined) return whole;
    const resolved = expand(value, depth + 1, slot);
    return key.toUpperCase().includes("PREFIX") ? resolved : resolved.replace(/^\s+/, "");
  });
}

/** Compile one phrase into its chunk list. */
function compile(source: string, slot: number): Compiled {
  const text = applyColors(expand(source, 0, slot));

  const parts: string[] = [];
  const slots: number[] = [];
  let last = 0;
  const re = /\{(\d+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push(text.slice(last, m.index));
    // Phrases are 1-BASED (`{1}` is the first argument), matching SourceMod and the SDK; `args` is a
    // plain 0-based array, so the index shifts here rather than at every call site.
    slots.push(parseInt(m[1]!, 10) - 1);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  slots.push(-1);

  const result: Compiled = {
    parts,
    slots,
    needsGrammar: text.includes("%s%") || /%an%/i.test(text),
  };
  compiled.set(source, result);
  return result;
}

/**
 * Pluralize `%s%` markers. A `%s%` takes an "s" unless the nearest preceding number is exactly 1
 * (or, with no preceding number, unless the word it attaches to already ends in "s").
 */
function pluralize(text: string): string {
  if (!text.includes("%s%")) return text;
  return text.replace(/([A-Za-z0-9]*)%s%/g, (_whole, word: string, index: number, whole: string) => {
    // Walk backwards for the most recent standalone integer.
    const before = whole.slice(0, index);
    let n = -1;
    const nums = before.match(/\d+/g);
    if (nums !== null && nums.length > 0) n = parseInt(nums[nums.length - 1]!, 10);
    if (n >= 0) return n === 1 ? word : `${word}s`;
    return word.toLowerCase().endsWith("s") ? word : `${word}s`;
  });
}

/** Choose "a" or "an" for each `%an%` from the first letter of the following word. */
function applyAn(text: string): string {
  return text.replace(/%(an)%/gi, (_whole, form: string, index: number, whole: string) => {
    const rest = whole.slice(index + 4);
    // Skip colour control bytes and punctuation to find the first real letter.
    const letter = /[A-Za-z0-9]/.exec(rest);
    const c = letter === null ? "" : letter[0]!.toLowerCase();
    const vowel = c === "a" || c === "e" || c === "i" || c === "o" || c === "u";
    return vowel ? form : form[0]!;
  });
}

/**
 * Collapse a possessive that became `s's` after pluralization (e.g. `{name}'%s%` where the name
 * already ends in "s") down to `s'`. Ported from the original's `handleTrailingS`.
 */
function fixPossessive(text: string): string {
  return text.includes("s's") ? text.replace(/s's\b/g, "s'") : text;
}

/**
 * The template for `key` in `slot`'s language, or undefined when the set has no such key.
 *
 * `translate` echoes the key back when it does not know it (SourceMod behaviour), so that is the
 * miss signal — otherwise an unknown key would compile the literal key as if it were a phrase.
 */
function lookup(slot: number, key: string): string | undefined {
  const t = Translations.translate(slot, key, ...TEMPLATE_ARGS);
  if (t === key) return undefined;
  return t.replace(RESTORE_MARKS, "{$1}");
}

/**
 * Format a phrase for the server default language. `args` fill `{1}`, `{2}`, … in declaration order.
 *
 * @example
 * msg("SHOP_PURCHASED", item.name)
 */
export function msg(key: string, ...args: (string | number)[]): string {
  return msgFor(-1, key, ...args);
}

/**
 * Format a phrase in `slot`'s own language. Use this for anything addressed to one player; `msg`
 * stays correct for chat-wide and console text.
 */
export function msgFor(slot: number, key: string, ...args: (string | number)[]): string {
  const source = lookup(slot, key) ?? seed[key];
  // An unknown key renders as the key itself — visible in game, and never a crash mid-round.
  if (source === undefined) return key;
  const c = compiled.get(source) ?? compile(source, slot);

  // Fast path: a constant phrase with no argument slots.
  if (c.parts.length === 1) {
    return c.needsGrammar ? fixPossessive(applyAn(pluralize(c.parts[0]!))) : c.parts[0]!;
  }

  let out = "";
  for (let i = 0; i < c.parts.length; i++) {
    out += c.parts[i]!;
    const slot = c.slots[i]!;
    if (slot >= 0) {
      const a = args[slot];
      out += a === undefined ? "" : typeof a === "number" ? formatNumber(a) : a;
    }
  }
  if (!c.needsGrammar) return out;
  return fixPossessive(applyAn(pluralize(out)));
}

/** Trim a float to at most two decimals without a trailing `.00` — matches the C# `{0:0.##}`. */
function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

/**
 * Register the phrase set with the SDK. Call once at load, before anything formats a message.
 *
 * `overrides` is the operator's flat `phrases_file`, folded into the SEED rather than replacing the
 * table — so an existing config keeps working while the SDK's own
 * `translations/<code>/ttt.phrases.json` files layer languages on top of it.
 */
export function installPhrases(overrides: Record<string, string> = {}): void {
  seed = { ...PHRASES, ...overrides };
  // A slot past TEMPLATE_ARGS would be erased by the SDK's formatter before this file ever saw it,
  // and the symptom is a silently missing value rather than an error — so say so at load, where an
  // operator adding a phrase to their overrides file will actually read it.
  for (const key in seed) {
    const text = seed[key]!;
    let m: RegExpExecArray | null;
    const re = /\{(\d+)\}/g;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1]!, 10);
      if (n < 1 || n > TEMPLATE_ARGS.length) {
        console.log(
          `[ttt] WARN: phrase "${key}" uses {${String(n)}}; slots are 1..${String(TEMPLATE_ARGS.length)} ` +
            `— it will render empty`,
        );
      }
    }
  }
  compiled.clear();
  Translations.load(SET, seed);
}

/** Warm the cache for the server default language so no message pays compilation cost mid-round. */
export function precompileAll(): void {
  for (const key in seed) {
    const source = lookup(-1, key) ?? seed[key];
    if (source !== undefined && !compiled.has(source)) compile(source, -1);
  }
}

/** The chat colour bytes, exposed for code that builds strings outside the phrase table. */
export { ChatColors };
