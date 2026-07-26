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
  assert.match(sql, /ADD COLUMN form_nonce_digest bytea NOT NULL/i);
  assert.match(sql, /ADD COLUMN continuation_binding bytea NOT NULL/i);
  assert.match(sql, /jsonb_typeof\(state_envelope\) = 'object'/i);
  assert.match(sql, /octet_length\(form_nonce_digest\) = 32/i);
  assert.match(sql, /octet_length\(continuation_binding\) = 32/i);
  assert.doesNotMatch(sql, /state\s+text/i);
  assert.doesNotMatch(sql, /code_verifier/i);
});
