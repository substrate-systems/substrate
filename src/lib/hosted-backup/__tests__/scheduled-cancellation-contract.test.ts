import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("scheduled cancellation persistence contract", () => {
  it("adds a nullable scheduled_cancel_at timestamp", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "migrations/0024_subscription_scheduled_cancellation.sql"),
      "utf8"
    );
    assert.match(
      migration,
      /ALTER TABLE subscriptions\s+ADD COLUMN scheduled_cancel_at timestamptz/i
    );
  });

  it("round-trips scheduled_cancel_at through subscription persistence", () => {
    const db = readFileSync(resolve(process.cwd(), "src/lib/hosted-backup/db.ts"), "utf8");
    assert.match(db, /scheduled_cancel_at: string \| null/);
    assert.match(db, /scheduledCancelAt\?: Date \| null/);
    assert.match(db, /scheduled_cancel_at = EXCLUDED\.scheduled_cancel_at/);
  });
});
