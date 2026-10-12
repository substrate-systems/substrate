import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assistantInstructions,
  CLIENT_GUIDES,
  PROM_CONTRACTS,
  PROM_LEVELS,
} from "../assistant-instructions";
import { INSTRUCTION_BLOCKS } from "../instruction-blocks.generated";

describe("each level hands over its own block from the Exomem doc", () => {
  it("returns a distinct, non-empty block for every level", () => {
    // A level that maps to nothing, or two levels that collapse to the same
    // block, would paste the wrong behaviour into someone's assistant.
    const rendered = PROM_LEVELS.map((level) => assistantInstructions(level));
    for (const [index, text] of rendered.entries()) {
      assert.ok(text.trim().length > 0, `${PROM_LEVELS[index]} has no block`);
    }
    assert.equal(new Set(rendered).size, PROM_LEVELS.length, "levels must not collapse");
  });

  it("does not hand a level the block of another", () => {
    // The generator maps doc headings to levels by their first word. The doc's
    // light, balanced and maximal blocks each open with their own level name, so
    // a swapped heading shows here. The off block carries no such line.
    for (const level of ["light", "balanced", "maximal"] as const) {
      assert.ok(
        assistantInstructions(level).includes(`Exomem prominence: ${level.toUpperCase()}.`),
        `${level} returns another level's block`
      );
    }
  });

  it("covers exactly the levels the generated blocks and the picker define", () => {
    // The sync script keeps its own list of levels and the picker uses
    // PROM_LEVELS. This ties the two lists, so a level added to one cannot end up
    // unselectable or without a block.
    assert.deepEqual(Object.keys(INSTRUCTION_BLOCKS).sort(), [...PROM_LEVELS].sort());
    for (const level of PROM_LEVELS) {
      assert.ok(PROM_CONTRACTS[level]?.summary, `${level} needs a picker summary`);
    }
  });
});

describe("every client is named with its own paste target", () => {
  it("covers the five flows", () => {
    assert.deepEqual(
      CLIENT_GUIDES.map((guide) => guide.client),
      ["claude", "chatgpt", "claude-code", "codex", "other"]
    );
  });

  it("gives every client somewhere specific to paste", () => {
    // The paste step is the one people get wrong, and the location differs per
    // client — a single generic "add it to your instructions" is what made the
    // previous version useless for anyone not on the one client it named.
    for (const guide of CLIENT_GUIDES) {
      assert.ok(guide.pasteTarget.length > 0, `${guide.name} needs a paste target`);
      assert.ok(guide.connect.length > 0, `${guide.name} needs connect guidance`);
    }
    const targets = CLIENT_GUIDES.map((guide) => guide.pasteTarget);
    assert.equal(new Set(targets).size, targets.length, "paste targets must be client-specific");
  });

  it("uses the real CLI syntax, verified against the installed tools", () => {
    const url = "https://example.test/mcp";
    // This used to assert the Codex pair too. Those commands were removed rather
    // than corrected: `codex mcp add` works and `codex mcp login` cannot, because
    // Codex authenticates by registering itself through RFC 7591 and Exomem has
    // no registration endpoint. The test was pinning syntax for a flow that never
    // completed, which is exactly the kind of green that hides a dead end.
    const claudeCode = CLIENT_GUIDES.find((g) => g.client === "claude-code")?.commands?.(url) ?? "";
    // `claude mcp add --transport http <name> <url>` is the documented HTTP form.
    assert.match(claudeCode, /claude mcp add --transport http exomem https:\/\/example\.test/);
  });
});

describe("a client that cannot connect says so instead of giving steps", () => {
  it("does not hand Codex CLI a login command that cannot succeed", () => {
    const codex = CLIENT_GUIDES.find((guide) => guide.client === "codex");
    assert.ok(codex);
    // `codex mcp login` fails: Codex registers itself via RFC 7591 dynamic
    // registration and Exomem has no registration endpoint. Shipping the command
    // sends someone into a browser sign-in that never arrives, with no way to
    // tell whether they made a mistake.
    assert.equal(codex.commands, undefined);
    assert.ok(codex.blocked);
    assert.match(codex.blocked, /register/i);
    // And it does not name a workaround that has not been observed working:
    // recommending another client on faith is the same defect one row down.
    assert.doesNotMatch(codex.blocked, /Claude Code/);
  });

  it("leaves every connectable client with a way in", () => {
    for (const guide of CLIENT_GUIDES.filter((candidate) => !candidate.blocked)) {
      assert.ok(guide.connect.length > 0, `${guide.client} has no connect step`);
      assert.ok(guide.pasteTarget.length > 0, `${guide.client} has no paste target`);
    }
  });

  it("never carries both a blocker and steps", () => {
    for (const guide of CLIENT_GUIDES) {
      if (guide.blocked)
        assert.equal(guide.commands, undefined, `${guide.client} contradicts itself`);
    }
  });
});
