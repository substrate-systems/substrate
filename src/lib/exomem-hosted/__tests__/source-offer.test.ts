import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceOfferReleaseText } from "../source-offer";

describe("sourceOfferReleaseText", () => {
  it("names the release that the cell runs", () => {
    assert.equal(sourceOfferReleaseText("v1.2.3"), "running release v1.2.3");
  });

  it("says no release is recorded when the reading found none, and says nothing without a reading", () => {
    assert.equal(sourceOfferReleaseText(null), "release not recorded");
    assert.equal(sourceOfferReleaseText(undefined), null);
  });
});
