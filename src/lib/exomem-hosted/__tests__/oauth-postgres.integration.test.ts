import assert from "node:assert/strict";
import { describe, it } from "node:test";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/**
 * This suite is intentionally database-gated: the CTE admission properties
 * require PostgreSQL's real data-modifying CTE semantics, not a SQL mock.
 */
describe("OAuth admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  it("requires a disposable EXOMEM_TEST_DATABASE_URL", async () => {
    assert.match(databaseUrl ?? "", /^postgres(?:ql)?:\/\//i);
  });
});
