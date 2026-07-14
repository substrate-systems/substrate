import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderExomemInviteEmail, renderExomemMagicLinkEmail } from "../exomem-access";

describe("Exomem access emails", () => {
  it("keeps invite bearer material in the URL fragment", () => {
    const token = Buffer.alloc(32, 0x61).toString("base64url");
    const accessUrl = `https://substratesystems.io/exomem/invite#${token}`;
    const rendered = renderExomemInviteEmail({
      accessUrl,
      expiresAt: new Date("2026-07-14T00:00:00.000Z"),
    });
    const all = `${rendered.htmlContent}\n${rendered.textContent}`;
    assert.ok(all.includes(accessUrl));
    assert.equal(all.includes(`?token=${token}`), false);
    assert.equal(rendered.subject.includes("Exomem"), true);
  });

  it("renders a product-branded returning-user email", () => {
    const rendered = renderExomemMagicLinkEmail({
      accessUrl: "https://substratesystems.io/exomem/invite#safe-token",
      expiresAt: new Date("2026-07-12T12:15:00.000Z"),
    });
    assert.match(rendered.subject, /Exomem/);
    assert.match(rendered.textContent, /works once/i);
  });
});
