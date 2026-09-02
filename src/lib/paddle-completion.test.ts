import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionMatchesProduct } from "./paddle";

describe("Paddle checkout completion scope", () => {
  it("does not let an unrelated completion satisfy an Endstate Cloud CTA", () => {
    assert.equal(completionMatchesProduct("transaction", "hosted_backup"), false);
  });

  it("accepts only a completion for the initiating product", () => {
    assert.equal(completionMatchesProduct("hosted_backup", "hosted_backup"), true);
    assert.equal(completionMatchesProduct("transaction", "transaction"), true);
    assert.equal(completionMatchesProduct(null, "hosted_backup"), false);
  });
});
