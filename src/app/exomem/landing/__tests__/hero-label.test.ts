import assert from "node:assert/strict";
import { test } from "node:test";
import { heroLabelOffset } from "../hero-graph";

test("a long tapped label remains inside the graph's bounds and text halo", () => {
  const offset = heroLabelOffset(
    { width: 358, height: 410 },
    { x: -28, y: 277, width: 128, height: 14 },
    [],
    5
  );
  assert.equal(-28 + offset.x, 2.5);
  assert.equal(offset.y, 0);
});

test("a tapped label moves clear of persistent labels using their measured bounds", () => {
  const label = { x: 226, y: 303, width: 116, height: 14 };
  const persistent = { x: 113, y: 306, width: 124, height: 15 };
  const offset = heroLabelOffset({ width: 358, height: 410 }, label, [persistent], 5);
  assert.equal(offset.x, 0);
  assert.equal(label.y + label.height + offset.y, persistent.y - 5);
});

test("an unclipped tapped label keeps the drawn position", () => {
  assert.deepEqual(
    heroLabelOffset(
      { width: 358, height: 410 },
      { x: 30, y: 20, width: 100, height: 14 },
      [{ x: 200, y: 20, width: 100, height: 14 }],
      5
    ),
    { x: 0, y: 0 }
  );
});
