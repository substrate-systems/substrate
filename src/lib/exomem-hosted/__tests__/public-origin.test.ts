import assert from "node:assert/strict";
import test from "node:test";
import { parseExomemPublicBaseUrl } from "../public-origin";

test("public origin parsing accepts HTTPS origins and development loopback HTTP", () => {
  assert.equal(
    parseExomemPublicBaseUrl("https://example.test", "production"),
    "https://example.test"
  );
  assert.equal(
    parseExomemPublicBaseUrl("http://127.0.0.1:3000", "development"),
    "http://127.0.0.1:3000"
  );
  assert.equal(parseExomemPublicBaseUrl("http://[::1]:3000", "test"), "http://[::1]:3000");
});

test("public origin parsing fails closed for unsafe or incomplete production values", () => {
  for (const value of [
    undefined,
    "http://example.test",
    "http://localhost:3000",
    "https://user:password@example.test",
    "https://example.test/exomem",
    "https://example.test?preview=1",
    "https://example.test#fragment",
  ]) {
    assert.throws(
      () => parseExomemPublicBaseUrl(value, "production"),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "PUBLIC_BASE_URL_INVALID"
    );
  }
});
