import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvitationInspection } from "@/lib/exomem-hosted/invites";
import { friendPriceOffered, pricePanel } from "../invite-view";

const EXPIRES = "2026-11-11T10:00:00.000Z";

describe("the invitation's price panel", () => {
  it("shows the friend price Paddle previewed, with the usual price struck", () => {
    const inspection: InvitationInspection = {
      status: "invite",
      email: "maria@example.test",
      expiresAt: EXPIRES,
      kind: "friend",
      inviter: { name: "Alex" },
      note: null,
      price: {
        value: {
          usual: { amount: "1500", currencyCode: "EUR" },
          friend: { value: { amount: "1000", currencyCode: "EUR" }, reason: null },
        },
        reason: null,
      },
    };

    assert.deepEqual(pricePanel(inspection), {
      label: "Friend price from Alex",
      main: "€10 a month",
      was: "€15",
      note: "For as long as you stay subscribed.",
    });
  });

  it("says the amount shows at checkout when Paddle did not answer, never a guess", () => {
    const inspection: InvitationInspection = {
      status: "invite",
      email: "maria@example.test",
      expiresAt: EXPIRES,
      kind: "friend",
      inviter: { name: "Alex" },
      note: null,
      price: { value: null, reason: "price_unavailable" },
    };

    assert.deepEqual(pricePanel(inspection), {
      label: "Friend price from Alex",
      main: "Shown at checkout",
      was: null,
      note: "Paddle shows the exact amount before you pay.",
    });
  });

  it("shows a covered invitation as nothing to pay, but not to an existing owner", () => {
    const covered = {
      kind: "covered" as const,
      inviter: { name: "Alex" },
      note: null,
      price: { value: null, reason: "covered" as const },
    };

    assert.equal(
      pricePanel({ status: "invite", email: "maria@example.test", expiresAt: EXPIRES, ...covered })
        ?.main,
      "Nothing to pay"
    );
    assert.equal(pricePanel({ status: "existing", signedIn: true, ...covered }), null);
  });

  it("offers an owner no friend price when their plan is on another price", () => {
    const inspection: InvitationInspection = {
      status: "existing",
      signedIn: true,
      kind: "friend",
      inviter: { name: "Alex" },
      note: null,
      price: {
        value: {
          usual: { amount: "1500", currencyCode: "EUR" },
          friend: { value: null, reason: "plan_price_differs" },
        },
        reason: null,
      },
    };

    assert.equal(friendPriceOffered(inspection), false);
    assert.equal(pricePanel(inspection), null);
  });
});
