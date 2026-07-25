/**
 * The TTT event bus.
 *
 * The C# original discovered handlers by reflecting over every listener's methods looking for
 * `[EventHandler]`, dispatched through `MethodInfo.Invoke` (boxing the event into an `object[]` per
 * call), and re-read the priority attribute *inside the comparator* on every re-sort. This is the
 * same contract — priority ordering, cancelation, `ignoreCanceled` — with none of that:
 *
 * - handlers live in a plain array per event key, sorted once at subscribe time;
 * - dispatch is a monomorphic `for` loop over that array with a direct call;
 * - the payload object is passed by reference (no boxing, no allocation per handler).
 *
 * Lower `priority` runs first, matching the original's `Priority` scale.
 */

/** Handler priority. Lower runs earlier — a MONITOR handler sees the final, settled event. */
export const Priority = {
  HIGHEST: 10,
  HIGHER: 20,
  HIGH: 40,
  DEFAULT: 60,
  LOW: 80,
  LOWER: 100,
  LOWEST: 200,
  MONITOR: 1000,
} as const;

/** Any event payload that can be vetoed by a handler. */
export interface Cancelable {
  canceled: boolean;
}

/** Options accepted when subscribing. */
export interface SubOptions {
  /** Ordering weight; lower runs first. @defaultValue {@link Priority.DEFAULT} */
  priority?: number;
  /** Skip this handler once another has canceled the event (the C# `IgnoreCanceled`). */
  ignoreCanceled?: boolean;
}

interface Entry<T> {
  fn: (ev: T) => void;
  priority: number;
  ignoreCanceled: boolean;
}

/**
 * A statically-typed bus over an event map. `K` keys are compile-time literals, so a typo is a
 * type error rather than a silently-dead subscription (the reflection version could not catch that).
 */
export class EventBus<M extends object> {
  // A null-prototype map: pure dictionary-mode lookup, no prototype chain walk on miss.
  private readonly lists: Record<string, Entry<never>[]> = Object.create(null) as Record<
    string,
    Entry<never>[]
  >;

  /** Subscribe to `key`. Handlers are kept sorted by priority; ties keep registration order. */
  on<K extends keyof M & string>(key: K, fn: (ev: M[K]) => void, opts?: SubOptions): void {
    const entry: Entry<M[K]> = {
      fn,
      priority: opts?.priority ?? Priority.DEFAULT,
      ignoreCanceled: opts?.ignoreCanceled ?? false,
    };
    const list = (this.lists[key] ??= []) as unknown as Entry<M[K]>[];
    // Insertion sort into an almost-always-tiny array: stable, and keeps dispatch alloc-free
    // (vs. re-sorting the whole list with a comparator that re-reads attributes, as the C# did).
    let i = list.length;
    while (i > 0 && list[i - 1]!.priority > entry.priority) i--;
    list.splice(i, 0, entry);
  }

  /**
   * Dispatch `ev` to every subscriber of `key`, in priority order. Returns the same object so
   * callers can read back handler mutations (`ev.canceled`, adjusted damage, rewritten role, …).
   */
  emit<K extends keyof M & string>(key: K, ev: M[K]): M[K] {
    const list = this.lists[key] as unknown as Entry<M[K]>[] | undefined;
    if (list === undefined) return ev;

    // Read the cancelable flag through a local so the common (non-cancelable) path never touches it.
    const cancelable = "canceled" in (ev as object);
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (cancelable && e.ignoreCanceled && (ev as unknown as Cancelable).canceled) continue;
      e.fn(ev);
    }
    return ev;
  }

  /** True if anything is listening — lets callers skip building a payload nobody will read. */
  has(key: keyof M & string): boolean {
    const list = this.lists[key];
    return list !== undefined && list.length > 0;
  }

  /** Drop every subscription (plugin unload). */
  clear(): void {
    for (const k in this.lists) delete this.lists[k];
  }
}
