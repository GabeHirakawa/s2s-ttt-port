/**
 * Runtime surfaces this plugin requires that are missing from the published
 * `@s2script/sdk@0.11.0` / `@s2script/cs2@0.11.1` declarations.
 *
 * `s2s build` only loads top-level `src/*.d.ts` as extra program roots.
 *
 * Required host: s2script `s2script/s2script` at or after
 * `a835e6c77d2b648392d53686f919738193dbe10b` (frame `phase`, `Events.setRecipients`,
 * `onClientCommand`, `ctx.items.onCanAcquire`).
 */
import type { HookResultValue } from "@s2script/sdk/events";

declare module "@s2script/sdk/plugin" {
  interface CtxServer {
    onGameFrame(
      fn: () => void,
      opts?: { priority?: "high" | "normal" | "low" | "monitor"; phase?: "pre" | "post" },
    ): void;
  }

  interface CtxCommands {
    onClientCommand(
      name: string,
      handler: (slot: number, argString: string) => HookResultValue | void,
    ): void;
  }

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
