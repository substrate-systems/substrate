import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

describe("the monthly update email's unsubscribe page", () => {
  it("is dynamic, kept out of indexes and sends no referrer, since its address holds the token", async (context) => {
    // Only the page module's exports are under test: its client component is stood in for.
    mock.module("../unsubscribe-client", { defaultExport: () => null });
    context.after(() => mock.reset());
    const page = await import("../page");
    const robots = page.metadata.robots as { index?: boolean; follow?: boolean; nocache?: boolean };
    assert.equal(page.dynamic, "force-dynamic");
    assert.equal(page.revalidate, 0);
    assert.deepEqual([robots.index, robots.follow, robots.nocache], [false, false, true]);
    assert.equal(page.metadata.referrer, "no-referrer");
  });
});
