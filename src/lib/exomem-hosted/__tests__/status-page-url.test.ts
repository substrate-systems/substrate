import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusPageUrl, statusPageUrlOrDefault } from "../status-page-url";

// One setting names the status page for Home's link and for service notices. Home links
// only when someone set an address; a notice always needs an address to point to.

describe("the status page address", () => {
  it("gives Home no link and notices the default page when nothing is set", () => {
    assert.equal(statusPageUrl({}), null);
    assert.equal(statusPageUrlOrDefault({}), "https://status.substratesystems.io");
  });

  it("gives both the configured https address, without stray spaces", () => {
    const env = { EXOMEM_STATUS_PAGE_URL: " https://status.example.test/ " };
    assert.equal(statusPageUrl(env), "https://status.example.test/");
    assert.equal(statusPageUrlOrDefault(env), "https://status.example.test/");
  });

  it("never sends a reader to a mistyped or non-https address", () => {
    for (const value of [
      "http://status.example.test",
      "status.example.test",
      "javascript:alert(1)",
    ]) {
      const env = { EXOMEM_STATUS_PAGE_URL: value };
      assert.equal(statusPageUrl(env), null, value);
      assert.equal(statusPageUrlOrDefault(env), "https://status.substratesystems.io", value);
    }
  });
});
