import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSupporterThankYou } from "../supporter";

describe("renderSupporterThankYou", () => {
  it("asks for explicit reply-based public-recognition consent", () => {
    const rendered = renderSupporterThankYou({ tier: "Patron" });

    assert.match(rendered.textContent, /reply.*yes.*name/i);
    assert.match(rendered.textContent, /not add.*without your permission/i);
    assert.match(rendered.htmlContent, /SUPPORTERS\.md/);
  });
});
