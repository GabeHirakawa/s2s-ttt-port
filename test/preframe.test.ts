import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindPreFrameIdentity,
  bindRoundEpoch,
  bumpMapEpoch,
  clearPreFrame,
  drainPreFrame,
  nextPreFrame,
  PREFRAME_MAX_QUEUED,
  preFrameDepth,
  preFrameDropped,
} from "../src/core/preframe.ts";

describe("nextPreFrame", () => {
  it("runs queued work on drain and not before", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    let ran = 0;
    nextPreFrame(() => {
      ran++;
    });
    assert.equal(ran, 0);
    drainPreFrame();
    assert.equal(ran, 1);
  });

  it("contains a throwing callback so the rest of the queue still runs", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    const seen: number[] = [];
    nextPreFrame(() => {
      seen.push(1);
      throw new Error("boom");
    });
    nextPreFrame(() => {
      seen.push(2);
    });
    drainPreFrame();
    assert.deepEqual(seen, [1, 2]);
  });

  it("does not run a job queued during drain until the next drain", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    let inner = false;
    nextPreFrame(() => {
      nextPreFrame(() => {
        inner = true;
      });
    });
    drainPreFrame();
    assert.equal(inner, false);
    drainPreFrame();
    assert.equal(inner, true);
  });

  it("drops a canceled handle", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    let ran = false;
    const handle = nextPreFrame(() => {
      ran = true;
    });
    handle.cancel();
    drainPreFrame();
    assert.equal(ran, false);
  });

  it("drops jobs stamped for a previous map epoch", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    let ran = false;
    nextPreFrame(() => {
      ran = true;
    });
    bumpMapEpoch();
    drainPreFrame();
    assert.equal(ran, false);
  });

  it("drops slot work after the occupant generation changes", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    let gen = 1;
    bindPreFrameIdentity(() => ({ steamId: "1", gen }));
    let ran = false;
    nextPreFrame(() => {
      ran = true;
    }, { slot: 3 });
    gen = 2;
    drainPreFrame();
    assert.equal(ran, false);
  });

  it("drops newest work once the queue is full", () => {
    clearPreFrame();
    bindRoundEpoch(() => 1);
    const before = preFrameDropped();
    for (let i = 0; i < PREFRAME_MAX_QUEUED; i++) nextPreFrame(() => { /* fill */ });
    assert.equal(preFrameDepth(), PREFRAME_MAX_QUEUED);
    let late = false;
    nextPreFrame(() => {
      late = true;
    });
    assert.equal(preFrameDropped(), before + 1);
    drainPreFrame();
    assert.equal(late, false);
    clearPreFrame();
  });
});
