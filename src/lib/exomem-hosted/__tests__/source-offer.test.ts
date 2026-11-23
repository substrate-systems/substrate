import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIRST_FSL_RELEASE,
  sourceOfferLicenceNote,
  sourceOfferLinks,
  sourceOfferReleaseText,
} from "../source-offer";

describe("sourceOfferReleaseText", () => {
  it("names the release that the cell runs", () => {
    assert.equal(sourceOfferReleaseText("v1.2.3"), "running release v1.2.3");
  });

  it("says no release is recorded when the reading found none, and says nothing without a reading", () => {
    assert.equal(sourceOfferReleaseText(null), "release not recorded");
    assert.equal(sourceOfferReleaseText(undefined), null);
  });
});

describe("sourceOfferLinks", () => {
  const server = (release: string | null | undefined) => sourceOfferLinks(release)[0];

  it("names AGPL-3.0-or-later and links the tag for a cell on a release before the licence change", () => {
    assert.deepEqual(server("v0.201.0"), {
      label: "Evermatter (AGPL-3.0-or-later)",
      href: "https://github.com/substrate-systems/evermatter/tree/v0.201.0",
    });
  });

  it("names FSL-1.1-ALv2 from the first FSL release on", () => {
    assert.equal(server(FIRST_FSL_RELEASE).label, "Evermatter (FSL-1.1-ALv2)");
    assert.equal(server("v0.202.1").label, "Evermatter (FSL-1.1-ALv2)");
    assert.equal(server("v1.0.0").label, "Evermatter (FSL-1.1-ALv2)");
  });

  it("names both licences and links the repository when the release is unknown or not a tag", () => {
    const both = `Evermatter (FSL-1.1-ALv2; before ${FIRST_FSL_RELEASE}: AGPL-3.0-or-later)`;
    for (const release of [undefined, null, "main-4f3a2b1", "0.202.0"]) {
      assert.deepEqual(server(release), {
        label: both,
        href: "https://github.com/substrate-systems/evermatter",
      });
    }
  });

  it("keeps the control plane under AGPL-3.0-or-later", () => {
    assert.equal(sourceOfferLinks("v9.9.9")[1].label, "Substrate (AGPL-3.0-or-later)");
  });
});

describe("sourceOfferLicenceNote", () => {
  it("states the FSL terms whenever the running release may be under FSL, and not for an AGPL release", () => {
    const note = sourceOfferLicenceNote("v0.202.0");
    assert.match(note ?? "", /free to self-host/);
    assert.match(note ?? "", /competing/);
    assert.match(note ?? "", /Apache-2\.0 two years after/);
    assert.equal(sourceOfferLicenceNote(undefined), note);
    assert.equal(sourceOfferLicenceNote("v0.201.0"), null);
  });
});
