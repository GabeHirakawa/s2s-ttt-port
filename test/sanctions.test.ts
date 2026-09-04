import { test } from "node:test";
import assert from "node:assert/strict";
import {
  queueSlays, owedBy, serveRoundStart, pardon, allOwed, resetSanctions, MAX_QUEUED,
} from "../src/rdm/sanctions.ts";

const alwaysLands = (): boolean => true;
const neverLands = (): boolean => false;

test("queued slays accumulate and are capped", () => {
  resetSanctions();
  assert.equal(queueSlays("STEAM_A", "Ann", 2), 2);
  assert.equal(queueSlays("STEAM_A", "Ann", 3), 5);
  assert.equal(queueSlays("STEAM_A", "Ann", 99), MAX_QUEUED);
});

test("a zero or negative count queues nothing", () => {
  resetSanctions();
  assert.equal(queueSlays("STEAM_A", "Ann", 0), 0);
  assert.equal(queueSlays("STEAM_A", "Ann", -3), 0);
  assert.equal(owedBy("STEAM_A"), 0);
});

test("one slay is served per round, not the whole debt at once", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 3);
  const first = serveRoundStart([{ slot: 1, steamId: "STEAM_A" }], alwaysLands);
  assert.deepEqual(first, [{ slot: 1, steamId: "STEAM_A", remaining: 2 }]);
  assert.equal(owedBy("STEAM_A"), 2);
});

test("a slay that does not land keeps the debt", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 1);
  const served = serveRoundStart([{ slot: 1, steamId: "STEAM_A" }], neverLands);
  assert.equal(served.length, 0);
  assert.equal(owedBy("STEAM_A"), 1, "a slay that failed must not be forgiven");
});

test("the debt clears once served in full", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 1);
  serveRoundStart([{ slot: 1, steamId: "STEAM_A" }], alwaysLands);
  assert.equal(owedBy("STEAM_A"), 0);
  assert.equal(allOwed().length, 0);
});

test("the debt follows the SteamID, not the slot", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 1);
  // Ann reconnects into a different slot; the sanction still finds her.
  const served = serveRoundStart([{ slot: 9, steamId: "STEAM_A" }], alwaysLands);
  assert.equal(served.length, 1);
  assert.equal(served[0]!.slot, 9);
});

test("an unrelated player in the sanctioned slot is not punished", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 1);
  const served = serveRoundStart([{ slot: 1, steamId: "STEAM_B" }], alwaysLands);
  assert.equal(served.length, 0, "slot reuse must never punish a stranger");
  assert.equal(owedBy("STEAM_A"), 1);
});

test("pardon clears and reports the debt", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 4);
  assert.equal(pardon("STEAM_A"), 4);
  assert.equal(owedBy("STEAM_A"), 0);
  assert.equal(pardon("STEAM_A"), 0);
});

test("a map reset drops every queue", () => {
  resetSanctions();
  queueSlays("STEAM_A", "Ann", 2);
  queueSlays("STEAM_B", "Bo", 1);
  resetSanctions();
  assert.equal(allOwed().length, 0);
});
