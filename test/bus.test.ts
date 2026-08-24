import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus, Priority } from "../src/core/bus.ts";

describe("EventBus", () => {
  it("isolates a throwing handler so later observers still run", () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const seen: number[] = [];
    bus.on("ping", () => {
      seen.push(1);
      throw new Error("boom");
    });
    bus.on("ping", (ev) => {
      seen.push(ev.n);
    });
    bus.emit("ping", { n: 2 });
    assert.deepEqual(seen, [1, 2]);
  });

  it("does not dispatch a subscription made during emit to that same event", () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const seen: string[] = [];
    bus.on("ping", () => {
      seen.push("first");
      bus.on("ping", () => {
        seen.push("late");
      });
    });
    bus.emit("ping", { n: 0 });
    assert.deepEqual(seen, ["first"]);
    bus.emit("ping", { n: 0 });
    assert.deepEqual(seen, ["first", "first", "late"]);
  });

  it("skips ignoreCanceled handlers after a veto", () => {
    const bus = new EventBus<{ ping: { canceled: boolean } }>();
    let ran = false;
    bus.on("ping", (ev) => {
      ev.canceled = true;
    }, { priority: Priority.HIGH });
    bus.on("ping", () => {
      ran = true;
    }, { ignoreCanceled: true });
    bus.emit("ping", { canceled: false });
    assert.equal(ran, false);
  });
});
