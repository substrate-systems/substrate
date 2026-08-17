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
