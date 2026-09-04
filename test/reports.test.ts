/**
 * RDM report store — the rules that protect an admin's screen and the report queue.
 *
 * The sanitizer tests are the important ones: the reason is the only place in this system where a
 * PLAYER controls what an ADMIN sees, and Panorama renders markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  file, pending, rule, resetReports, newRound, sanitizeReason, ago,
  Verdict, FileResult, REPORTS_PER_ROUND,
} from "../src/rdm/reports.ts";

function mk(over: Partial<Parameters<typeof file>[0]> = {}) {
  return file({
    reporterSlot: 0, reporterName: "alice",
    accusedSlot: 1, accusedName: "bob", accusedSteamId: "765611980000001",
    reason: "shot me in spawn", round: 3, now: 1000, ...over,
  });
}

test("sanitize escapes Panorama markup — a reason cannot restyle an admin's HUD", () => {
  const out = sanitizeReason("<font color='#ff0000'>WARNING</font>");
  assert.ok(!out.includes("<font"), "raw markup survived");
  assert.ok(out.includes("&lt;font"), "expected escaped angle brackets");
});

test("sanitize collapses newlines so a wall of text cannot push the panel apart", () => {
  assert.equal(sanitizeReason("a\n\n\nb   c"), "a b c");
});

test("sanitize caps length", () => {
  const out = sanitizeReason("x".repeat(500));
  assert.ok(out.length <= 240, `length ${out.length} exceeded the cap`);
  assert.ok(out.endsWith("…"), "expected truncation marker");
});

test("a report is filed and appears pending", () => {
  resetReports();
  const { result, report } = mk();
  assert.equal(result, FileResult.Ok);
  assert.equal(pending().length, 1);
  assert.equal(report?.reason, "shot me in spawn");
});

test("self-reports are refused", () => {
  resetReports();
  assert.equal(mk({ accusedSlot: 0 }).result, FileResult.SelfReport);
});

test("an empty or whitespace-only reason is refused", () => {
  resetReports();
  assert.equal(mk({ reason: "   \n  " }).result, FileResult.EmptyReason);
});

test("the same reporter cannot double-report the same person while pending", () => {
  resetReports();
  assert.equal(mk().result, FileResult.Ok);
  assert.equal(mk({ reason: "again" }).result, FileResult.Duplicate);
});

test("rate limit is per round and clears on newRound", () => {
  resetReports();
  for (let i = 0; i < REPORTS_PER_ROUND; i++) {
    assert.equal(mk({ accusedSteamId: `id${i}`, accusedName: `bob${i}` }).result, FileResult.Ok);
  }
  assert.equal(mk({ accusedSteamId: "another" }).result, FileResult.RateLimited);
  newRound();
  assert.equal(mk({ accusedSteamId: "another" }).result, FileResult.Ok);
});

test("ruling removes it from pending and records slays only when guilty", () => {
  resetReports();
  const a = mk().report!;
  assert.equal(rule(a.id, Verdict.Guilty, 2, "admin")?.slays, 2);
  assert.equal(pending().length, 0);

  resetReports();
  const b = mk().report!;
  assert.equal(rule(b.id, Verdict.Innocent, 5, "admin")?.slays, 0,
    "slays must be zero for a not-guilty verdict");
});

test("a report cannot be ruled twice", () => {
  resetReports();
  const r = mk().report!;
  assert.ok(rule(r.id, Verdict.Guilty, 1, "admin"));
  assert.equal(rule(r.id, Verdict.Innocent, 0, "admin2"), undefined);
});

test("ago renders coarse relative time", () => {
  assert.equal(ago(1000, 1003), "just now");
  assert.equal(ago(1000, 1030), "30s ago");
  assert.equal(ago(1000, 1150), "2m ago");
});
