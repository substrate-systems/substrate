import assert from "node:assert/strict";
import test from "node:test";
import { markNumbers, stepEnds } from "../writing-e";

test("the current step writes from its predecessor and finishes at the letter's corner", () => {
  assert.deepEqual(markNumbers(18, "progress", { steps: 5, step: 2 }), {
    w: 7,
    b: 11,
    rest: 0,
    cls: "",
  });
  assert.deepEqual(markNumbers(10, "progress", { steps: 5, step: 5 }), {
    w: 10,
    b: 10,
    rest: 0,
    cls: "done",
  });
});

test("processes with more steps than corners retain every real step", () => {
  const ends = stepEnds(18, 7);
  assert.equal(ends.length, 7);
  assert.equal(ends.at(-1), 18);
  assert.ok(ends.every((end, i) => end > (ends[i - 1] ?? 0)));
});

test("percentage progress clamps the stroke and failure unwrites without claiming Exomem is off", () => {
  assert.deepEqual(markNumbers(18, "progress", { value: 2 }), {
    w: 18,
    b: 18,
    rest: 0,
    cls: "done",
  });
  assert.equal(markNumbers(18, "progress", { value: -1 }).w, 0);
  assert.deepEqual(markNumbers(18, "failed"), { w: 0, b: 0, rest: 0, cls: "" });
  assert.equal(markNumbers(18, "off").cls, "off");
});
