/**
 * `ctx.items.onCanAcquire` is on current s2script main but not in the published
 * `@s2script/cs2@0.13.0` types (npm 2026-08-11). Frame phase, `onClientCommand`, and
 * `Events.setRecipients` now come from `@s2script/sdk@0.21.0`.
 *
 * `s2s build` only loads top-level `src/*.d.ts` as extra program roots.
 */
import type { HookResultValue } from "@s2script/sdk/events";

declare module "@s2script/sdk/plugin" {
  interface PluginContext {
    readonly items?: {
      onCanAcquire(
        handler: (view: {
          readonly player: { readonly slot: number } | null;
          readonly defIndex: number;
          readonly method: number;
          result: number;
          readonly skipped: boolean;
        }) => HookResultValue | void,
      ): void;
    };
  }
}
