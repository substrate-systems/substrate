import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { moved, selectionAllowed, toggled } from "../whats-new-state";

describe("Exomem monthly What's new page", () => {
  it("is private, dynamic, excluded from indexing and sends no referrer", async (context) => {
    // Only the page module's exports are under test: its stylesheet and client component are stood in for.
    mock.module("../../../home/home.module.css", { defaultExport: {} });
    mock.module("../whats-new-client", { defaultExport: () => null });
    context.after(() => mock.reset());
    const page = await import("../page");
    const robots = page.metadata.robots as { index?: boolean; follow?: boolean; nocache?: boolean };
    assert.equal(page.dynamic, "force-dynamic");
    assert.equal(page.revalidate, 0);
    assert.deepEqual([robots.index, robots.follow, robots.nocache], [false, false, true]);
    assert.equal(page.metadata.referrer, "no-referrer");
  });
});

describe("the page's selection helpers", () => {
  const note = (position: number) => ({ version: "1.0.0", position });

  it("allows 3 to 6 notes, and none only where the page offers a skip", () => {
    assert.deepEqual(
      [0, 2, 3, 6, 7].map((count) => selectionAllowed(count, false)),
      [false, false, true, true, false]
    );
    assert.equal(selectionAllowed(0, true), true);
    assert.equal(selectionAllowed(2, true), false);
  });

  it("stops a pick at six notes, and a second click removes a note", () => {
    const six = [0, 1, 2, 3, 4, 5].map(note);
    assert.equal(toggled(six, note(6)).length, 6);
    assert.deepEqual(
      toggled(six, note(2)).map((n) => n.position),
      [0, 1, 3, 4, 5]
    );
  });

  it("moves a note one place and leaves the list alone at its ends", () => {
    assert.deepEqual(moved([1, 2, 3], 1, -1), [2, 1, 3]);
    assert.deepEqual(moved([1, 2, 3], 0, -1), [1, 2, 3]);
    assert.deepEqual(moved([1, 2, 3], 2, 1), [1, 2, 3]);
  });
});
