import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderExomemAppSignoutEmail } from "../../email-templates/exomem-lifecycle";

// The sign-out notice's copy (notify-owner-of-app-signout). Which endings
// email is classified once in oauth-family-end.ts: the exhaustive map makes
// an unclassified reason a compile error, so no test re-lists literals here.

describe("the app sign-out email", () => {
  const input = {
    homeUrl: "https://exomem.example.test/exomem/home",
    appName: "Claude",
    appNameClaimed: false,
    signedOutAt: new Date("2026-11-23T09:00:00Z"),
    timeZone: "UTC",
    scheme: null,
  };

  it("names the app, the day, the consequence and the remedy, without blame", () => {
    const email = renderExomemAppSignoutEmail(input);
    assert.equal(email.subject, "Claude can’t reach your Exomem");
    assert.match(email.textContent, /On 23 November, Claude’s connection to your Exomem ended/);
    assert.match(email.textContent, /nothing Claude saves reaches your Exomem/);
    assert.match(email.textContent, /Open Claude and connect Exomem again/);
    assert.doesNotMatch(email.textContent, /revoked|replay|expired|suspicious/i);
  });

  it("marks a self-declared name as the app's own claim", () => {
    const email = renderExomemAppSignoutEmail({ ...input, appName: "Codex", appNameClaimed: true });
    assert.match(email.textContent, /“Codex” is what the app calls itself/);
  });

  it("keeps the subject inside its slot however long the app's name is", () => {
    const long = "A".repeat(60);
    const email = renderExomemAppSignoutEmail({ ...input, appName: long });
    assert.ok(email.subject.length <= 45, email.subject);
    assert.match(email.textContent, new RegExp(long));
  });
});
