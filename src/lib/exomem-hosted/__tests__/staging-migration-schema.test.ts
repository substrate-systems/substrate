import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertExpectedMigrationSchema } from "../../../../scripts/migrate";

describe("staging migration schema guard", () => {
  it("rejects a search path that falls through to public because the staging schema is absent", async () => {
    const sql = {
      query: async () => ({ rows: [{ schema_name: "public" }] }),
    };

    await assert.rejects(
      assertExpectedMigrationSchema(sql as never, "exomem_hosted_staging"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "EXOMEM_STAGING_SCHEMA_UNAVAILABLE");
        assert.doesNotMatch(error.message, /postgres|public|exomem_hosted_staging/i);
        return true;
      }
    );
  });

  it("accepts only the expected schema as the effective current schema", async () => {
    const sql = {
      query: async () => ({ rows: [{ schema_name: "exomem_hosted_staging" }] }),
    };

    await assert.doesNotReject(
      assertExpectedMigrationSchema(sql as never, "exomem_hosted_staging")
    );
  });
});
