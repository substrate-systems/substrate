import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderExomemCoveredInvitationEmail } from "../exomem-invites";

describe("Exomem invitation emails", () => {
  it("renders the inviter's name and note as text, never as markup", () => {
    const rendered = renderExomemCoveredInvitationEmail({
      acceptUrl: "https://substratesystems.io/exomem/invite#token",
      inviterName: "Alex & Co",
      note: '<img src=x onerror="alert(1)"> see you',
      inviteeEmail: "invitee@example.test",
      expiresAt: new Date("2026-11-11T09:00:00Z"),
      timeZone: null,
    });
    assert.equal(rendered.htmlContent.includes("<img"), false);
    assert.ok(rendered.htmlContent.includes("&lt;img"));
    assert.ok(rendered.htmlContent.includes("Alex &amp; Co"));
  });
});
