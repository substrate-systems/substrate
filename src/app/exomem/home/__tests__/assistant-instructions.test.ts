import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assistantInstructions,
  CLIENT_GUIDES,
  DEFAULT_PROM_LEVEL,
  PROM_CONTRACTS,
  PROM_LEVELS,
  type PromLevel,
} from "../assistant-instructions";

describe("the instructions block carries the behaviour, because nothing else does", () => {
  it("always states the store, the boundary, and the memory precedence", () => {
    // Without a marketplace plugin there are no skills, so a bare MCP
    // connection leaves the assistant with tools and no reason to use them.
    // These three lines are the whole behavioural contract and are never
    // level-dependent.
    for (const level of PROM_LEVELS) {
      const text = assistantInstructions(level);
      assert.match(text, /long-term governed knowledge store/);
      assert.match(text, /Never capture transient chat, credentials/);
      assert.match(text, /Exomem is the durable store/);
    }
  });

  it("carries all three axes for every level", () => {
    for (const level of PROM_LEVELS) {
      const text = assistantInstructions(level);
      for (const axis of ["RECALL:", "CAPTURE:", "NARRATION:"]) {
        assert.ok(text.includes(axis), `${level} is missing ${axis}`);
      }
    }
  });

  it("produces genuinely different text per level", () => {
    const rendered = PROM_LEVELS.map((level) => assistantInstructions(level));
    assert.equal(new Set(rendered).size, PROM_LEVELS.length, "levels must not collapse");
  });

  it("says never for off and before every substantive turn for maximal", () => {
    assert.match(assistantInstructions("off"), /Never search memory/);
    assert.match(assistantInstructions("maximal"), /before answering any substantive turn/);
  });

  it("defaults to maximal, matching WEB_DEFAULT_PROMINENCE for hookless surfaces", () => {
    // exomem/src/exomem/prominence.py defaults web/hosted/chatgpt/claude-ai to
    // maximal, because there are no hooks there to re-arm the check each turn.
    assert.equal(DEFAULT_PROM_LEVEL, "maximal");
  });

  it("pins the level set against the engine's, which it cannot import", () => {
    // Transcribed across a repo and language boundary. If prominence.py grows or
    // loses a level, this is the tripwire.
    assert.deepEqual([...PROM_LEVELS], ["off", "light", "balanced", "maximal"]);
    for (const level of PROM_LEVELS) {
      assert.ok(PROM_CONTRACTS[level as PromLevel]?.summary, `${level} needs a picker summary`);
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
    const url = "https://example.test/api/exomem/mcp/v1";
    // This used to assert the Codex pair too. Those commands were removed rather
    // than corrected: `codex mcp add` works and `codex mcp login` cannot, because
    // Codex authenticates by registering itself through RFC 7591 and Exomem has
    // no registration endpoint. The test was pinning syntax for a flow that never
    // completed, which is exactly the kind of green that hides a dead end.
    const claudeCode = CLIENT_GUIDES.find((g) => g.client === "claude-code")?.commands?.(url) ?? "";
    // `claude mcp add --transport http <name> <url>` is the documented HTTP form.
    assert.match(claudeCode, /claude mcp add --transport http exomem https:\/\/example\.test/);
  });

  it("marks only the chat clients installable, since no CLI has a marketplace listing", () => {
    const installable = CLIENT_GUIDES.filter((g) => g.installable).map((g) => g.client);
    assert.deepEqual(installable, ["claude", "chatgpt"]);
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
