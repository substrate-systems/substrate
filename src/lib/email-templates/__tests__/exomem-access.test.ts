import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderExomemDeletionCompleteEmail,
  renderExomemDeletionEmail,
  renderExomemInviteEmail,
  renderExomemMagicLinkEmail,
  renderExomemWelcomeEmail,
} from "../exomem-access";

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

  it("states expiry as a duration and a labelled UTC instant, never a raw ISO stamp", () => {
    const rendered = renderExomemInviteEmail({
      accessUrl: "https://substratesystems.io/exomem/invite#safe-token",
      expiresAt: new Date("2026-08-15T12:00:40.632Z"),
      now: new Date("2026-08-08T12:00:00.000Z"),
    });
    assert.match(
      rendered.textContent,
      /This invitation expires in 7 days, on 15 August 2026 at 12:00 UTC\./
    );
    assert.equal(rendered.textContent.includes("2026-08-15T12:00:40.632Z"), false);
    assert.equal(rendered.htmlContent.includes("2026-08-15T12:00:40.632Z"), false);
  });

  it("scales the duration down to the units a short-lived link needs", () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    const cases: [string, string][] = [
      ["2026-08-08T12:01:00.000Z", "in 1 minute"],
      ["2026-08-08T12:15:00.000Z", "in 15 minutes"],
      ["2026-08-08T13:00:00.000Z", "in 1 hour"],
      ["2026-08-09T12:00:00.000Z", "in 24 hours"],
      ["2026-08-10T12:00:00.000Z", "in 2 days"],
    ];
    for (const [expiry, expected] of cases) {
      const rendered = renderExomemMagicLinkEmail({
        accessUrl: "https://substratesystems.io/exomem/invite#safe-token",
        expiresAt: new Date(expiry),
        now,
      });
      assert.match(rendered.textContent, new RegExp(`This sign-in link expires ${expected},`));
    }
  });

  it("does not claim a lapsed link is still good", () => {
    const rendered = renderExomemDeletionEmail({
      accessUrl: "https://substratesystems.io/exomem/delete#safe-token",
      expiresAt: new Date("2026-08-08T11:00:00.000Z"),
      now: new Date("2026-08-08T12:00:00.000Z"),
    });
    assert.match(rendered.textContent, /This confirmation expired on 8 August 2026 at 11:00 UTC\./);
  });

  it("states only provider-verified deletion as complete", () => {
    const rendered = renderExomemDeletionCompleteEmail();
    const all = `${rendered.htmlContent}\n${rendered.textContent}`;

    assert.equal(rendered.subject, "Your Exomem has been deleted");
    assert.match(all, /hosted Exomem has been permanently deleted/i);
    assert.match(all, /vault, files, exports, and encryption keys/i);
    assert.match(all, /shared Substrate identity.*remain untouched/is);
    assert.doesNotMatch(all, /confirm|in progress/i);
  });

  it("uses the same expiry wording for the self-serve welcome", () => {
    const rendered = renderExomemWelcomeEmail({
      accessUrl: "https://substratesystems.io/exomem/setup#safe-token",
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
      now: new Date("2026-08-08T12:00:00.000Z"),
    });
    assert.match(
      rendered.textContent,
      /This setup link expires in 24 hours, on 9 August 2026 at 12:00 UTC\./
    );
  });
});
