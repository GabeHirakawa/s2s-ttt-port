import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus } from "../src/core/bus.ts";
import { applyStateTransition } from "../src/core/state-commit.ts";
import type { TttEvents } from "../src/core/events.ts";

/** Numeric stand-ins for `GameState` — `const enum` is erased under strip-types. */
const Waiting = 0;
const InProgress = 2;

describe("applyStateTransition", () => {
  it("leaves state unchanged and skips observers when gameStateChanging is vetoed", () => {
    const bus = new EventBus<TttEvents>();
    const holder = { state: Waiting };
    const seen: number[] = [];
    bus.on("gameStateChanging", (ev) => {
      ev.canceled = true;
    });
    bus.on("gameState", (ev) => {
      seen.push(ev.state);
    });
    assert.equal(applyStateTransition(bus, holder, InProgress), false);
    assert.equal(holder.state, Waiting);
    assert.deepEqual(seen, []);
  });

  it("writes state before gameState observers run", () => {
    const bus = new EventBus<TttEvents>();
    const holder = { state: Waiting };
    let observed = -1;
    bus.on("gameState", (ev) => {
      assert.equal(holder.state, ev.state);
      observed = ev.state;
    });
    assert.equal(applyStateTransition(bus, holder, InProgress), true);
    assert.equal(holder.state, InProgress);
    assert.equal(observed, InProgress);
  });
});
