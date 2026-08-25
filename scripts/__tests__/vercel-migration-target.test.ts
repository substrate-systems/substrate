import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VercelMigrationTargetError,
  resolveVercelMigrationTarget,
} from "../vercel-migration-target";

describe("Vercel migration target", () => {
  it("preserves production migration behavior", () => {
    assert.deepEqual(
      resolveVercelMigrationTarget({
        VERCEL_ENV: "production",
        DATABASE_URL: "postgresql://example.invalid/substrate",
      }),
      { action: "migrate", target: "production" }
    );
  });

  it("skips an ordinary feature preview", () => {
    assert.deepEqual(
      resolveVercelMigrationTarget({
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "feat/something",
      }),
      { action: "skip", reason: "non-deployment-target" }
    );
  });

  it("allows only the exact enabled staging branch and named database", () => {
    assert.deepEqual(
      resolveVercelMigrationTarget({
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_restore_verification",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://user:secret@example.invalid/exomem_restore_verification?sslmode=require&options=-c%20search_path%3Dexomem_hosted_staging%2Cpublic",
      }),
      { action: "migrate", target: "staging" }
    );
  });

  for (const [name, env, code] of [
    [
      "missing explicit flag",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_restore_verification",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://example.invalid/exomem_restore_verification?options=-c%20search_path%3Dexomem_hosted_staging%2Cpublic",
      },
      "EXOMEM_STAGING_FLAG_MISMATCH",
    ],
    [
      "wrong branch",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "feat/not-staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_restore_verification",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://example.invalid/exomem_restore_verification?options=-c%20search_path%3Dexomem_hosted_staging%2Cpublic",
      },
      "EXOMEM_STAGING_BRANCH_MISMATCH",
    ],
    [
      "missing database name",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://example.invalid/exomem_restore_verification?options=-c%20search_path%3Dexomem_hosted_staging%2Cpublic",
      },
      "EXOMEM_STAGING_DATABASE_NAME_REQUIRED",
    ],
    [
      "wrong database",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_hosted_staging",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://example.invalid/production_database?options=-c%20search_path%3Dexomem_hosted_staging%2Cpublic",
      },
      "EXOMEM_STAGING_DATABASE_MISMATCH",
    ],
    [
      "missing schema name",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_restore_verification",
        DATABASE_URL: "postgresql://example.invalid/exomem_restore_verification",
      },
      "EXOMEM_STAGING_SCHEMA_NAME_REQUIRED",
    ],
    [
      "wrong schema",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_restore_verification",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://example.invalid/exomem_restore_verification?options=-c%20search_path%3Dpublic",
      },
      "EXOMEM_STAGING_SCHEMA_MISMATCH",
    ],
    [
      "missing public extension schema",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        EXOMEM_HOSTED_STAGING: "true",
        EXOMEM_HOSTED_STAGING_DATABASE_NAME: "exomem_restore_verification",
        EXOMEM_HOSTED_STAGING_SCHEMA_NAME: "exomem_hosted_staging",
        DATABASE_URL:
          "postgresql://example.invalid/exomem_restore_verification?options=-c%20search_path%3Dexomem_hosted_staging",
      },
      "EXOMEM_STAGING_SCHEMA_MISMATCH",
    ],
  ] as const) {
    it(`refuses staging migration with ${name}`, () => {
      assert.throws(
        () => resolveVercelMigrationTarget(env),
        (error: unknown) => {
          assert.ok(error instanceof VercelMigrationTargetError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, /secret|production_database|postgresql/);
          return true;
        }
      );
    });
  }
});
