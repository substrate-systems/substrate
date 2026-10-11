import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homeSections } from "../home-sections";

describe("the authenticated first run leads with connecting an assistant", () => {
  it("puts connect first", () => {
    // The defect this module exists to prevent: capture and search first, with
    // connect buried in a collapsed panel underneath them.
    assert.equal(homeSections()[0], "connect");
  });

  it("keeps account controls last", () => {
    assert.equal(homeSections().at(-1), "account");
  });
});
