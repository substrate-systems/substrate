import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectSteps, homeSections } from "../home-sections";

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

describe("every assistant gets its own named path", () => {
  const clients = (platforms: readonly ("claude" | "openai")[]) =>
    connectSteps(platforms).map((step) => step.client);

  it("names all three clients even when no install action exists", () => {
    // This is the case that matters most and the one the first version got
    // wrong. Install actions require a live artifact matching the promoted
    // contract digest, which is false for both platforms until a promotion
    // window has run — so a newly invited person normally sees none. They must
    // still find their own assistant by name.
    assert.deepEqual(clients([]), ["claude", "chatgpt", "codex"]);
  });

  it("never leaves a Claude user reading instructions headed Codex", () => {
    const steps = connectSteps([]);
    const claude = steps.find((step) => step.client === "claude");
    assert.ok(claude, "Claude must always have its own card");
    assert.equal(claude.oneClick, false, "with no install action it is the manual path");
  });

  it("marks a client one-click only when its own install action exists", () => {
    const steps = connectSteps(["claude"]);
    assert.equal(steps.find((s) => s.client === "claude")?.oneClick, true);
    assert.equal(steps.find((s) => s.client === "chatgpt")?.oneClick, false);
  });

  it("maps the openai platform key to the ChatGPT card", () => {
    // The database calls it `openai`; the person calls it ChatGPT.
    assert.equal(connectSteps(["openai"]).find((s) => s.client === "chatgpt")?.oneClick, true);
  });

  it("never offers Codex a one-click install, which does not exist", () => {
    for (const platforms of [[], ["claude"], ["openai"], ["claude", "openai"]] as const) {
      assert.equal(connectSteps(platforms).find((s) => s.client === "codex")?.oneClick, false);
    }
  });

  it("orders the clients deterministically regardless of input order", () => {
    assert.deepEqual(clients(["openai", "claude"]), clients(["claude", "openai"]));
  });
});
