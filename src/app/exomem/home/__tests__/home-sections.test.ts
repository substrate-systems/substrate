import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homeSections } from "../home-sections";

describe("the authenticated first run leads with connecting an assistant", () => {
  it("puts connect above capture", () => {
    // The defect this module exists to prevent: capture and search first, with
    // connect buried in a collapsed panel underneath them.
    const sections = homeSections();
    assert.equal(sections[0], "connect");
    assert.ok(sections.indexOf("connect") < sections.indexOf("capture"));
  });

  it("keeps account controls last", () => {
    assert.equal(homeSections().at(-1), "account");
  });

  it("still offers capture \u2014 connect-first is a demotion, not a removal", () => {
    assert.ok(homeSections().includes("capture"));
  });
});
