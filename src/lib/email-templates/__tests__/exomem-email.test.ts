import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderExomemMagicLinkEmail } from "../exomem-access";
import { exomemSenderName } from "../exomem-email";
import {
  renderExomemDeletionReminderEmail,
  renderExomemPaymentFailedEmail,
  renderExomemReadyEmail,
  renderExomemSubscriptionEndedEmail,
} from "../exomem-lifecycle";

const NOW = new Date("2026-10-12T09:00:00.000Z");
const DAY = 86_400_000;

describe("Exomem emails", () => {
  it("keeps a sign-in token in the URL fragment, out of server logs and referrers", () => {
    const token = Buffer.alloc(32, 0x61).toString("base64url");
    const accessUrl = `https://substratesystems.io/exomem/sign-in#${token}`;
    const rendered = renderExomemMagicLinkEmail({
      accessUrl,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
      now: NOW,
    });
    assert.ok(rendered.htmlContent.includes(`href="${accessUrl}"`));
    assert.ok(rendered.textContent.includes(accessUrl));
    assert.equal(rendered.htmlContent.includes(`?token=${token}`), false);
  });

  it("renders a person's name as text, never as markup", () => {
    const rendered = renderExomemReadyEmail({
      homeUrl: "https://substratesystems.io/exomem/home",
      recipientName: "<img src=x onerror=alert(1)>",
      connected: true,
      billing: { price: "€10", nextPaymentAt: null, friendInviterName: "Alex</td><script>" },
      timeZone: "Europe/Berlin",
    });
    assert.equal(rendered.htmlContent.includes("<img src=x"), false);
    assert.equal(rendered.htmlContent.includes("<script>"), false);
    assert.ok(rendered.htmlContent.includes("&lt;img src=x onerror=alert(1)&gt;"));
  });

  it("sends as the person only under a clean display name", () => {
    assert.equal(exomemSenderName("Alex"), "Alex via Exomem");
    assert.equal(
      exomemSenderName("Alex\r\nBcc: victim@example.com"),
      "Alex Bcc victim example.com via Exomem"
    );
    assert.equal(exomemSenderName("support@bank.example"), "support bank.example via Exomem");
    assert.equal(exomemSenderName("‮​ "), "Exomem");
    assert.equal([...exomemSenderName("x".repeat(200))].length, 60 + " via Exomem".length);
  });

  it("says 'connected' only when an app is connected", () => {
    const ready = (connected: boolean) =>
      renderExomemReadyEmail({
        homeUrl: "https://substratesystems.io/exomem/home",
        recipientName: null,
        connected,
        billing: null,
        timeZone: null,
      }).textContent;
    assert.match(ready(true), /Exomem is set up and connected\./);
    assert.match(ready(false), /Welcome\. Exomem is set up\. Ask/);
  });

  it("gives the read-only end date when the dunning window is known, and no invented date when not", () => {
    const known = renderExomemPaymentFailedEmail({
      billingUrl: "https://substratesystems.io/exomem/home",
      readOnlyUntil: new Date(NOW.getTime() + 14 * DAY),
      timeZone: "Europe/Berlin",
    }).textContent;
    assert.match(known, /If it still hasn’t worked by 26 October, your subscription ends\./);
    const unknown = renderExomemPaymentFailedEmail({
      billingUrl: "https://substratesystems.io/exomem/home",
      readOnlyUntil: null,
      timeZone: "Europe/Berlin",
    }).textContent;
    assert.match(unknown, /If it still doesn’t work, your subscription ends\./);
  });

  it("promises the reminder only when it is queued", () => {
    const ended = (reminderScheduled: boolean) =>
      renderExomemSubscriptionEndedEmail({
        exportUrl: "https://substratesystems.io/exomem/home",
        resubscribeUrl: "https://substratesystems.io/exomem/home",
        keptUntil: new Date(NOW.getTime() + 30 * DAY),
        now: NOW,
        reminderScheduled,
        timeZone: null,
      }).textContent;
    assert.match(ended(true), /We’ll remind you a week before\./);
    assert.doesNotMatch(ended(false), /remind you/);
  });

  it("counts the days left at send, not the days the board drew", () => {
    const reminder = (daysLeft: number) =>
      renderExomemDeletionReminderEmail({
        exportUrl: "https://substratesystems.io/exomem/home",
        resubscribeUrl: "https://substratesystems.io/exomem/home",
        keptUntil: new Date(NOW.getTime() + daysLeft * DAY),
        now: NOW,
        timeZone: null,
      });
    assert.equal(reminder(7).subject, "7 days until your Exomem is deleted");
    assert.equal(reminder(1).subject, "1 day until your Exomem is deleted");
  });
});
