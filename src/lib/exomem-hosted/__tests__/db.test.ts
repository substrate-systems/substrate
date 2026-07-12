import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __setExomemSqlForTests,
  redeemInviteAtomic,
  resolveActiveCellBinding,
  type ExomemSql,
} from "../db";

afterEach(() => __setExomemSqlForTests(null));

describe("Exomem hosted database boundary", () => {
  it("redeems through one atomic statement and concurrent replay creates no second tenant", async () => {
    let consumed = false;
    let queryCount = 0;
    let capturedSql = "";
    const sql: ExomemSql = async (strings) => {
      queryCount += 1;
      capturedSql = strings.join("?");
      await Promise.resolve();
      if (consumed) return { rows: [], rowCount: 0 };
      consumed = true;
      return {
        rows: [
          {
            user_id: "user-1",
            tenant_id: "tenant-1",
            session_id: "session-1",
            operation_id: "operation-1",
          },
        ],
        rowCount: 1,
      };
    };
    __setExomemSqlForTests(sql);

    const params = {
      tokenDigest: Buffer.alloc(32, 1),
      sessionDigest: Buffer.alloc(32, 2),
      csrfDigest: Buffer.alloc(32, 3),
      sessionExpiresAt: new Date("2026-07-13T00:00:00.000Z"),
    };
    const results = await Promise.all([redeemInviteAtomic(params), redeemInviteAtomic(params)]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(new Set(results.filter(Boolean).map((row) => row?.tenantId)).size, 1);
    assert.equal(queryCount, 2, "one database statement per redemption attempt");
    assert.match(capturedSql, /FOR UPDATE/i);
    assert.match(capturedSql, /INSERT INTO users/i);
    assert.match(capturedSql, /INSERT INTO exomem_tenants/i);
    assert.match(capturedSql, /INSERT INTO exomem_entitlements/i);
    assert.match(capturedSql, /ON CONFLICT \(tenant_id\) DO NOTHING/i);
    assert.doesNotMatch(
      capturedSql,
      /ON CONFLICT \(tenant_id\) DO UPDATE[\s\S]{0,240}effective_state/i
    );
    assert.match(capturedSql, /INSERT INTO exomem_sessions/i);
    assert.match(capturedSql, /INSERT INTO exomem_lifecycle_operations/i);
    assert.match(capturedSql, /UPDATE exomem_invites/i);
    assert.match(capturedSql, /expires_at > now\(\)/i);
  });

  it("allows magic-link authentication for every non-deleted owner state", async () => {
    const statements: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      statements.push(strings.join("?"));
      return { rows: [], rowCount: 0 };
    });
    const { createMagicAccessToken, redeemMagicAccessTokenAtomic } = await import("../db");
    await createMagicAccessToken({
      emailNormalized: "owner@example.com",
      tokenDigest: Buffer.alloc(32, 4),
      expiresAt: new Date("2026-07-13T00:00:00.000Z"),
    });
    await redeemMagicAccessTokenAtomic({
      tokenDigest: Buffer.alloc(32, 4),
      sessionDigest: Buffer.alloc(32, 5),
      csrfDigest: Buffer.alloc(32, 6),
      sessionExpiresAt: new Date("2026-07-14T00:00:00.000Z"),
    });
    for (const statement of statements) {
      assert.match(statement, /tenant\.status <> 'deleted'/i);
      assert.doesNotMatch(statement, /effective_state IN \('active', 'grace'\)/i);
      assert.doesNotMatch(statement, /tenant\.status = 'active'/i);
    }
  });

  it("fails closed when active cell lookup is ambiguous", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        { id: "cell-1", tenant_id: "tenant-1" },
        { id: "cell-2", tenant_id: "tenant-1" },
      ],
      rowCount: 2,
    }));
    await assert.rejects(
      () => resolveActiveCellBinding("tenant-1"),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_MAPPING_AMBIGUOUS"
    );
  });

  it("publishes a candidate through one atomic expected-binding swap", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return {
        rows: [{ cell_id: "cell-new", previous_cell_id: "cell-old" }],
        rowCount: 1,
      };
    });
    const { bindActiveCellAtomic } = await import("../db");
    const result = await bindActiveCellAtomic({
      tenantId: "tenant-1",
      candidateCellId: "cell-new",
      expectedPreviousCellId: "cell-old",
    });
    assert.deepEqual(result, {
      cellId: "cell-new",
      previousCellId: "cell-old",
    });
    assert.match(statement, /FOR UPDATE/i);
    assert.match(statement, /FROM exomem_tenants/i);
    assert.match(statement, /SET bound_cell_id = swap_guard\.candidate_id/i);
    assert.match(statement, /SET routing_state = 'retiring'/i);
    assert.match(statement, /SET routing_state = 'bound'/i);
    assert.match(statement, /expected-binding|expectedPreviousCellId|previous_id/i);
  });

  it("serializes two initial candidates on the tenant binding row", async () => {
    let boundCell: string | null = null;
    let calls = 0;
    __setExomemSqlForTests(async (_strings, ...values) => {
      calls += 1;
      const candidateCellId = String(values[1]);
      await Promise.resolve();
      if (boundCell !== null) return { rows: [], rowCount: 0 };
      boundCell = candidateCellId;
      return {
        rows: [{ cell_id: candidateCellId, previous_cell_id: null }],
        rowCount: 1,
      };
    });
    const { bindActiveCellAtomic } = await import("../db");
    const results = await Promise.all([
      bindActiveCellAtomic({
        tenantId: "tenant-1",
        candidateCellId: "cell-a",
        expectedPreviousCellId: null,
      }),
      bindActiveCellAtomic({
        tenantId: "tenant-1",
        candidateCellId: "cell-b",
        expectedPreviousCellId: null,
      }),
    ]);
    assert.equal(calls, 2);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(boundCell === "cell-a" || boundCell === "cell-b", true);
  });
});
