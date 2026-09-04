import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptOffer, decline, offer, resetPrompts, Stage, stageOf, sweep, takeContext,
  OFFER_SECONDS, CONTEXT_SECONDS,
} from "../src/rdm/prompt.ts";

const SUBJECT = { accusedSlot: 2, accusedName: "Bob", accusedSteamId: "765", round: 3, what: "x" };

test("an offer moves through yes -> context -> filed", () => {
  resetPrompts();
  assert.ok(offer(1, SUBJECT, 0));
  assert.equal(stageOf(1), Stage.Offered);
  assert.ok(acceptOffer(1, 0));
  assert.equal(stageOf(1), Stage.AwaitingContext);
  const s = takeContext(1);
  assert.equal(s?.accusedName, "Bob");
  assert.equal(stageOf(1), Stage.Idle, "consuming the context clears the slot");
});

test("takeContext returns null for a slot that was never asked", () => {
  resetPrompts();
  // The common case, and the one that must never eat an ordinary chat line.
  assert.equal(takeContext(5), null);
});

test("takeContext returns null while still only Offered", () => {
  resetPrompts();
  offer(1, SUBJECT, 0);
  assert.equal(takeContext(1), null, "a message before answering yes is normal chat");
});

test("declining clears the slot", () => {
  resetPrompts();
  offer(1, SUBJECT, 0);
  assert.ok(decline(1));
  assert.equal(stageOf(1), Stage.Idle);
});

test("an unanswered offer expires", () => {
  resetPrompts();
  offer(1, SUBJECT, 0);
  assert.equal(sweep(OFFER_SECONDS - 1).length, 0, "not yet");
  const lapsed = sweep(OFFER_SECONDS);
  assert.deepEqual(lapsed, [{ slot: 1, stage: Stage.Offered }]);
  assert.equal(stageOf(1), Stage.Idle);
});

test("accepting extends the deadline to the context window", () => {
  resetPrompts();
  offer(1, SUBJECT, 0);
  acceptOffer(1, 0);
  assert.equal(sweep(OFFER_SECONDS).length, 0, "the offer clock no longer applies");
  assert.equal(sweep(CONTEXT_SECONDS).length, 1);
});

test("a second death replaces the pending question rather than queueing", () => {
  resetPrompts();
  offer(1, SUBJECT, 0);
  offer(1, { ...SUBJECT, accusedName: "Carol", accusedSlot: 3 }, 0);
  acceptOffer(1, 0);
  assert.equal(takeContext(1)?.accusedName, "Carol");
});

test("you cannot be asked about killing yourself", () => {
  resetPrompts();
  assert.equal(offer(2, SUBJECT, 0), false, "accused === victim");
});
