import test from "node:test";
import assert from "node:assert/strict";
import { classifyKill, KillClass } from "../src/rdm/suspect.ts";

const INNO = false, TRAITOR = true;

test("a Traitor killing an Innocent is never questioned", () => {
  assert.equal(classifyKill(INNO, TRAITOR, false), KillClass.Clean);
});

test("Innocent on Innocent is same-side", () => {
  assert.equal(classifyKill(INNO, INNO, false), KillClass.SameSide);
});

test("Traitor on Traitor is same-side", () => {
  assert.equal(classifyKill(TRAITOR, TRAITOR, false), KillClass.SameSide);
});

test("an Innocent killing an unprovoked Traitor is still asked about", () => {
  // Right outcome, no evidence — the shape of a lucky RDM.
  assert.equal(classifyKill(TRAITOR, INNO, false), KillClass.UnprovokedOnTraitor);
});

test("self-defence clears every case", () => {
  // The victim opened fire first, so whatever the roles were, the kill is theirs to own.
  assert.equal(classifyKill(TRAITOR, INNO, true), KillClass.Clean);
  assert.equal(classifyKill(INNO, INNO, true), KillClass.Clean);
  assert.equal(classifyKill(TRAITOR, TRAITOR, true), KillClass.Clean);
});
