import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIRST_FSL_RELEASE, sourceOfferLinks, sourceOfferReleaseText } from "../source-offer";

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
  const serverLabel = (release: string | null | undefined) => sourceOfferLinks(release)[0].label;
  const [major, minor] = FIRST_FSL_RELEASE;

  it("names AGPL-3.0 for a cell that runs a release from before the licence change", () => {
    assert.equal(serverLabel(`v${major}.${minor - 1}.9`), "Evermatter (AGPL-3.0)");
  });

  it("names FSL-1.1-ALv2 from the first FSL release on", () => {
    assert.equal(serverLabel(FIRST_FSL_RELEASE.join(".")), "Evermatter (FSL-1.1-ALv2)");
    assert.equal(serverLabel(`v${major}.${minor}.1`), "Evermatter (FSL-1.1-ALv2)");
    assert.equal(serverLabel(`${major + 1}.0.0`), "Evermatter (FSL-1.1-ALv2)");
  });

  it("names both licences when the release is unknown or not a plain version", () => {
    const both = `Evermatter (FSL-1.1-ALv2; releases before ${FIRST_FSL_RELEASE.join(".")}: AGPL-3.0)`;
    assert.equal(serverLabel(undefined), both);
    assert.equal(serverLabel(null), both);
    assert.equal(serverLabel("main-4f3a2b1"), both);
  });

  it("keeps the control plane under AGPL-3.0", () => {
    assert.equal(sourceOfferLinks("v9.9.9")[1].label, "Substrate (AGPL-3.0)");
  });
});
