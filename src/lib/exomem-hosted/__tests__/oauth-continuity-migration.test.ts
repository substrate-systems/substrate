import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("OAuth continuity stores an encrypted state envelope and no browser secret", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "migrations/0029_exomem_oauth_continuity.sql"),
    "utf8"
  );

  assert.match(sql, /ADD COLUMN state_envelope jsonb NOT NULL/i);
  assert.match(sql, /jsonb_typeof\(state_envelope\) = 'object'/i);
  assert.doesNotMatch(sql, /state\s+text/i);
  assert.doesNotMatch(sql, /code_verifier/i);
});
