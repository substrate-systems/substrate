import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { exomemTokens } from "@/lib/exomem/design-tokens";
import { renderExomemMagicLinkEmail } from "../exomem-access";
import { exomemEmailSchemeQuery, exomemSenderName } from "../exomem-email";
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

  it("builds a light email on light throughout, with dark only in its dark-scheme block", () => {
    // Gmail on the web reads the inline styles and shows the first image only. A light
    // base must put every light value there, and the dark values only in the block.
    const { dark, light } = exomemTokens();
    const html = renderExomemMagicLinkEmail({
      accessUrl: "https://substratesystems.io/exomem/sign-in#token",
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
      now: NOW,
      scheme: "light",
    }).htmlContent;
    const [head, body] = html.split("</head>");
    const block = head.slice(head.indexOf(`@media ${exomemEmailSchemeQuery("dark")}`));

    assert.ok(block.length < head.length, "the email has a dark-scheme block");
    assert.equal(head.includes(exomemEmailSchemeQuery("light")), false);
    for (const name of ["--bg-frame", "--bg-base", "--fg-primary", "--fg-body"]) {
      assert.notEqual(light[name], dark[name], name);
      assert.ok(body.includes(light[name]), `${name} is light inline`);
      assert.equal(body.includes(dark[name]), false, `${name} is never dark inline`);
      assert.ok(block.includes(dark[name]), `${name} is dark in the block`);
    }
    // The first image shown is the light one; its dark twin follows, hidden until the block.
    assert.ok(body.slice(0, body.indexOf('.png"')).endsWith("-light"));
    assert.ok(block.includes(".x-img-light { display: none"), "the block hides the light image");
    assert.ok(head.includes('<meta name="color-scheme" content="light dark">'));
  });

  it("renders a person's name as text, never as markup", () => {
    const rendered = renderExomemReadyEmail({
      scheme: null,
      homeUrl: "https://substratesystems.io/exomem/home",
      recipientName: "<img src=x onerror=alert(1)>",
      connected: true,
      billing: {
        price: { amount: "1000", currencyCode: "EUR" },
        nextPaymentAt: null,
        friendInviterName: "Alex</td><script>",
      },
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
        scheme: null,
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
      scheme: null,
      billingUrl: "https://substratesystems.io/exomem/home",
      readOnlyUntil: new Date(NOW.getTime() + 14 * DAY),
      timeZone: "Europe/Berlin",
    }).textContent;
    assert.match(known, /If it still hasn’t worked by 26 October, your subscription ends\./);
    const unknown = renderExomemPaymentFailedEmail({
      scheme: null,
      billingUrl: "https://substratesystems.io/exomem/home",
      readOnlyUntil: null,
      timeZone: "Europe/Berlin",
    }).textContent;
    assert.match(unknown, /If it still doesn’t work, your subscription ends\./);
  });

  it("promises the reminder only when it is queued", () => {
    const ended = (reminderScheduled: boolean) =>
      renderExomemSubscriptionEndedEmail({
        scheme: null,
        exportUrl: "https://substratesystems.io/exomem/home",
        supportUrl: "https://substratesystems.io/exomem/support",
        resubscribeUrl: "https://substratesystems.io/exomem/home",
        keptUntil: new Date(NOW.getTime() + 30 * DAY),
        now: NOW,
        reminderScheduled,
        timeZone: null,
      }).textContent;
    assert.match(ended(true), /We’ll remind you a week before\./);
    assert.doesNotMatch(ended(false), /remind you/);
  });

  it("sends an ended owner to support for a copy, and promises no export, while Home offers none", () => {
    const ended = renderExomemSubscriptionEndedEmail({
      scheme: null,
      exportUrl: null,
      supportUrl: "https://substratesystems.io/exomem/support",
      resubscribeUrl: "https://substratesystems.io/exomem/home",
      keptUntil: new Date(NOW.getTime() + 30 * DAY),
      now: NOW,
      reminderScheduled: true,
      timeZone: null,
    });
    assert.doesNotMatch(ended.textContent, /export/i);
    assert.match(ended.textContent, /For a copy before then, write to support\./);
    assert.ok(ended.htmlContent.includes('href="https://substratesystems.io/exomem/support"'));
  });

  it("counts the days left at send, not the days the board drew", () => {
    const reminder = (daysLeft: number) =>
      renderExomemDeletionReminderEmail({
        scheme: null,
        exportUrl: "https://substratesystems.io/exomem/home",
        supportUrl: "https://substratesystems.io/exomem/support",
        resubscribeUrl: "https://substratesystems.io/exomem/home",
        keptUntil: new Date(NOW.getTime() + daysLeft * DAY),
        now: NOW,
        timeZone: null,
      });
    assert.equal(reminder(7).subject, "7 days until your Exomem is deleted");
    assert.equal(reminder(1).subject, "1 day until your Exomem is deleted");
  });
});

describe("explicit account email theme", () => {
  for (const themeChoice of ["light", "dark"] as const) {
    it(`keeps an explicit ${themeChoice} email in that scheme without a device override`, () => {
      const email = renderExomemMagicLinkEmail({
        accessUrl: "https://example.test/sign-in",
        expiresAt: new Date(Date.now() + 60_000),
        scheme: themeChoice === "light" ? "dark" : "light",
        themeChoice,
      });
      const html = new JSDOM(email.htmlContent).window.document;
      assert.equal(
        html.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
        themeChoice
      );
      assert.equal(email.htmlContent.includes("prefers-color-scheme"), false);
      assert.equal(html.querySelectorAll("img").length, 2);
    });
  }
});
