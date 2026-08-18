import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAGIC_LINK_TTL_MINUTES,
  RESEND_COOLDOWN_SECONDS,
  sentScreen,
} from "../sign-in-copy";

describe("the sent screen is not a dead end", () => {
  it("always offers a way to get another link", () => {
    // The previous version ended on "You can close this page." A typo in the
    // address, a link opened late, or a mail in spam all landed there with
    // nothing to do next.
    const ready = sentScreen(0);
    assert.equal(ready.resendLabel, "Send another link");
    assert.equal(ready.waitingLabel, null);
  });

  it("says the link expires, and says it in minutes", () => {
    // A link opened twenty minutes later fails. Unless the screen said so, that
    // reads as a broken product rather than a stale link.
    const screen = sentScreen(0);
    assert.match(screen.expiry, new RegExp(`${MAGIC_LINK_TTL_MINUTES} minutes`));
    assert.match(screen.expiry, /works once/);
  });

  it("says that resending retires the link already sent", () => {
    // Delivery is queued and was measured at ~40 seconds, so the resend button
    // gets pressed while the first mail is still in flight. Redeeming the older
    // link then fails with SUPERSEDED_MAGIC_LINK — a failure nobody can attribute
    // unless the screen said, before they clicked, that this would happen.
    const screen = sentScreen(0);
    assert.match(screen.supersedes, /stops the previous one working/);
    assert.match(screen.supersedes, /newest/);
  });

  it("gives a next step when no mail arrives, without confirming the address exists", () => {
    // requestMagicLink answers `if_eligible_email_sent` for a typo and for a live
    // account alike, so the screen must not resolve which one happened. It can
    // still name what a person can check.
    const screen = sentScreen(0);
    assert.match(screen.notArriving, /spam/i);
    assert.match(screen.notArriving, /address matches/i);
    for (const revealing of [/no account/i, /not registered/i, /does not exist/i, /unknown/i]) {
      assert.doesNotMatch(
        screen.notArriving,
        revealing,
        "the sent screen must never disclose whether an address has an Exomem"
      );
    }
  });

  it("holds the resend back while cooling down, and counts down visibly", () => {
    // The server's limit is silent: requestMagicLink answers
    // `if_eligible_email_sent` whether it queued a mail or refused one. Without
    // this, someone impatient spends all five hourly attempts seeing no
    // difference at all.
    const cooling = sentScreen(42);
    assert.equal(cooling.resendLabel, null);
    assert.match(cooling.waitingLabel ?? "", /42s/);
  });

  it("keeps the cooldown well inside the hourly server allowance", () => {
    // EXOMEM_RATE_LIMITS.magicLinkAccount is 5 per hour. At this cooldown a
    // determined clicker still cannot exhaust it by accident.
    assert.ok(RESEND_COOLDOWN_SECONDS >= 30, "too short to protect the allowance");
    assert.ok(RESEND_COOLDOWN_SECONDS <= 120, "too long to be usable after a typo");
  });

  it("never reveals whether the address has an Exomem", () => {
    // The API response is deliberately opaque; the copy has to match it, or the
    // screen becomes the enumeration oracle the endpoint refuses to be.
    assert.match(sentScreen(0).lede, /If that address has an Exomem/);
  });
});
