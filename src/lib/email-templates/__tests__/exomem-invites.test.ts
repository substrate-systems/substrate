import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderExomemCoveredInvitationEmail,
  renderExomemFriendInvitationEmail,
} from "../exomem-invites";

describe("Exomem invitation emails", () => {
  for (const length of [40, 41]) {
    it(`uses ${length === 40 ? "the inviter's name" : "the generic subject"} for a ${length}-character inviter`, () => {
      const inviterName = "𐐀".repeat(length);
      const rendered = renderExomemFriendInvitationEmail({
        scheme: null,
        acceptUrl: "https://substratesystems.io/exomem/invite#token",
        inviterName,
        note: null,
        inviteeEmail: "invitee@example.test",
        expiresAt: new Date("2026-11-11T09:00:00Z"),
        timeZone: null,
        usualPrice: { amount: "1500", currencyCode: "EUR" },
        friendPrice: { amount: "1000", currencyCode: "EUR" },
      });
      assert.equal(
        rendered.subject,
        length === 40 ? `${inviterName} invited you to Exomem` : "You’re invited to Exomem"
      );
      assert.ok(rendered.textContent.includes(inviterName));
    });
  }

  it("renders the inviter's name and note as text, never as markup", () => {
    const rendered = renderExomemCoveredInvitationEmail({
      scheme: null,
      acceptUrl: "https://substratesystems.io/exomem/invite#token",
      inviterName: "Alex & Co",
      note: '<img src=x onerror="alert(1)"> see you',
      inviteeEmail: "invitee@example.test",
      expiresAt: new Date("2026-11-11T09:00:00Z"),
      timeZone: null,
    });
    assert.equal(rendered.htmlContent.includes("<img src=x"), false);
    assert.ok(rendered.htmlContent.includes("&lt;img src=x"));
    assert.ok(rendered.htmlContent.includes("Alex &amp; Co"));
  });
});
