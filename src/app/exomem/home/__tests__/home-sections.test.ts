import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectRoutes, homeSections } from "../home-sections";

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

  it("still offers capture — connect-first is a demotion, not a removal", () => {
    assert.ok(homeSections().includes("capture"));
  });
});

describe("the connect section always leaves a route forward", () => {
  it("offers the manual server URL even when no install action exists", () => {
    // Install actions require a live client artifact matching the promoted
    // contract digest. That is a release-pipeline fact, so a perfectly healthy
    // tenant can legitimately see none, and must not be left with nothing.
    assert.deepEqual(connectRoutes([]), ["manual-url"]);
  });

  it("leads with a one-click install where one is available", () => {
    const routes = connectRoutes(["claude"]);
    assert.equal(routes[0], "claude-install");
    assert.ok(routes.includes("manual-url"), "the manual route is never dropped");
  });

  it("orders the platforms deterministically regardless of input order", () => {
    assert.deepEqual(connectRoutes(["openai", "claude"]), connectRoutes(["claude", "openai"]));
  });

  it("keeps the manual URL last so it reads as the fallback it is", () => {
    assert.equal(connectRoutes(["claude", "openai"]).at(-1), "manual-url");
  });
});
