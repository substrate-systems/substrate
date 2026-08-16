import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consentSections } from "../consent-audience";

describe("the consent page offers one path per audience", () => {
  it("gives a signed-in visitor only the connect action", () => {
    assert.deepEqual(consentSections({ signedIn: true, reviewerEnabled: true }), ["connect"]);
  });

  it("never offers connect to a visitor with no session", () => {
    // `/oauth/authorize/complete` resolves a session before it will mint a code,
    // so a connect button is an action that can only end in access_denied for
    // someone who has not redeemed their invitation yet.
    const sections = consentSections({ signedIn: false, reviewerEnabled: true });
    assert.ok(!sections.includes("connect"));
  });

  it("leads with the email instruction and demotes the paste field below it", () => {
    // Nobody pastes a URL into a form, and nobody has to: redeeming an invitation
    // while an OAuth continuation cookie is present mints the authorization code
    // in the same step, so clicking the emailed link finishes the connection.
    const sections = consentSections({ signedIn: false, reviewerEnabled: true });
    assert.equal(sections[0], "check-email");
    assert.ok(sections.indexOf("check-email") < sections.indexOf("paste-invitation"));
  });

  it("keeps reviewer credentials last, below every user-facing path", () => {
    // This is the ordering defect that cost the 2026-08-16 window: the reviewer
    // form sat above the path the person actually needed.
    const sections = consentSections({ signedIn: false, reviewerEnabled: true });
    assert.equal(sections.at(-1), "reviewer");
    for (const userFacing of ["check-email", "sign-in", "paste-invitation"] as const) {
      assert.ok(
        sections.indexOf(userFacing) < sections.indexOf("reviewer"),
        `${userFacing} must precede the reviewer path`
      );
    }
  });

  it("offers a returning visitor a route back into the same flow", () => {
    // They have an Exomem but no session on this device; without this they have
    // no way forward at all.
    assert.ok(consentSections({ signedIn: false, reviewerEnabled: false }).includes("sign-in"));
  });

  it("omits the reviewer path entirely when the flag is off", () => {
    const sections = consentSections({ signedIn: false, reviewerEnabled: false });
    assert.ok(!sections.includes("reviewer"));
    assert.ok(sections.includes("check-email"), "the invited path must survive");
  });
});
