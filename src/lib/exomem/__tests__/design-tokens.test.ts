import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exomemTokens } from "../design-tokens";

// The OG image and the emails cannot read CSS variables; they get literal values from
// the tokens stylesheet. An edit to that file's shape must not hand them a broken value.
describe("literal token values for renderers without CSS variables", () => {
  it("resolves every token to a literal value in both themes", () => {
    const { dark, light } = exomemTokens();

    for (const [theme, tokens] of Object.entries({ dark, light })) {
      for (const [name, value] of Object.entries(tokens)) {
        // Only the font stacks may keep a var(): next/font defines those families at runtime.
        if (name.startsWith("--font-")) continue;
        assert.doesNotMatch(value, /var\(/, `${theme} ${name} = ${value}`);
      }
    }
  });

  it("gives light its own values, derived lines included", () => {
    const { dark, light } = exomemTokens();

    assert.notEqual(light["--bg-base"], dark["--bg-base"]);
    // Derived lines follow the theme's ink, not dark's.
    assert.notEqual(light["--exo-rule"], dark["--exo-rule"]);
  });
});
