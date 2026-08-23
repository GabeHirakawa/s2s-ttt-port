import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearIndexedBodies,
  forgetIndexedBody,
  lookupBodyByIndex,
  lookupBodyByOwner,
  registerIndexedBody,
  type BodyIndexRecord,
} from "../src/cs2/body-index.ts";

function fakeRef(index: number, valid = true): { isValid(): boolean; index: number } {
  return {
    index,
    isValid: () => valid,
  };
}

function record(index: number, owner: number, valid = true): BodyIndexRecord {
  return { ref: fakeRef(index, valid), index, owner };
}

describe("lookupBodyByIndex", () => {
  it("returns the live body for a matching valid ref", () => {
    clearIndexedBodies();
    const body = record(42, 3);
    registerIndexedBody(body);
    assert.equal(lookupBodyByIndex(42), body);
    assert.equal(lookupBodyByOwner(3), body);
  });

  it("evicts a body whose ref is no longer valid", () => {
    clearIndexedBodies();
    const body = record(42, 3, false);
    registerIndexedBody(body);
    assert.equal(lookupBodyByIndex(42), undefined);
    assert.equal(lookupBodyByOwner(3), undefined);
    assert.equal(lookupBodyByIndex(42), undefined);
  });

  it("evicts a body whose ref now names a different index", () => {
    clearIndexedBodies();
    const ref = fakeRef(99, true);
    const body: BodyIndexRecord = { ref, index: 42, owner: 1 };
    registerIndexedBody(body);
    assert.equal(lookupBodyByIndex(42), undefined);
    assert.equal(lookupBodyByOwner(1), undefined);
  });

  it("forgetIndexedBody drops every map without caring about the ref", () => {
    clearIndexedBodies();
    const body = record(7, 2);
    registerIndexedBody(body);
    forgetIndexedBody(body);
    assert.equal(lookupBodyByIndex(7), undefined);
    assert.equal(lookupBodyByOwner(2), undefined);
  });
});
