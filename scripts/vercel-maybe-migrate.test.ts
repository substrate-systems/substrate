import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationTarget } from "./vercel-maybe-migrate";

// A preview of any other branch must never migrate: its database variables
// could name a database that this build does not own.
test("migrates production and the staging branch only", () => {
  assert.equal(migrationTarget({ VERCEL_ENV: "production" }), "production");
  assert.equal(
    migrationTarget({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" }),
    "staging"
  );
  assert.equal(migrationTarget({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/x" }), null);
  assert.equal(
    migrationTarget({ VERCEL_ENV: "development", VERCEL_GIT_COMMIT_REF: "staging" }),
    null
  );
  assert.equal(migrationTarget({}), null);
});
