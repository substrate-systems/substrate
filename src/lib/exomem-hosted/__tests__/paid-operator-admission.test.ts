import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemTransactionForTests, type ExomemSql } from "../db";
import { admitFirstOAuthInviteAtomic } from "../oauth-store";

afterEach(() => {
  __setExomemTransactionForTests(null);
});

function admissionSql(source: "complimentary" | "paddle") {
  const statements: string[] = [];
  const tx: ExomemSql = async (strings) => {
    const statement = strings.join("?");
    statements.push(statement);

    if (statement.includes("FROM exomem_invites")) {
      return {
        rows: [
          {
            id: "018f2d91-7c42-7000-8000-000000000001",
            email_normalized: "friend@example.test",
            entitlement_source: source,
            entitlement_capabilities: ["capture", "recall"],
            entitlement_limits: { storageBytes: 1024 },
            marketplace_reviewer_purpose: false,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      statement.includes("FROM exomem_oauth_authorization_transactions AS transaction") &&
      statement.includes("FOR UPDATE OF transaction")
    ) {
      return {
        rows: [
          {
            id: "018f2d91-7c42-7000-8000-000000000002",
            client_id: "018f2d91-7c42-7000-8000-000000000003",
            redirect_uri: "https://client.example.test/callback",
            resource: "https://exomem.substratesystems.io/mcp",
            requested_scopes: ["exomem.read"],
            pkce_challenge: "challenge",
          },
        ],
        rowCount: 1,
      };
    }
    if (statement.includes("INSERT INTO users")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000004" }], rowCount: 1 };
    }
    if (statement.includes("UPDATE exomem_capacity_pools AS pool")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000005" }], rowCount: 1 };
    }
    if (statement.includes("INSERT INTO exomem_tenants")) {
      return {
        rows: [{ id: "018f2d91-7c42-7000-8000-000000000006", fence_generation: 1 }],
        rowCount: 1,
      };
    }
    if (statement.includes("INSERT INTO exomem_entitlements")) {
      return {
        rows: [{ tenant_id: "018f2d91-7c42-7000-8000-000000000006" }],
        rowCount: 1,
      };
    }
    if (statement.includes("INSERT INTO exomem_lifecycle_operations")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000007" }], rowCount: 1 };
    }
    if (statement.includes("INSERT INTO exomem_capacity_allocations")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000008" }], rowCount: 1 };
    }
    if (statement.includes("INSERT INTO exomem_sessions")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000009" }], rowCount: 1 };
    }
    if (statement.includes("INSERT INTO exomem_oauth_grants")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000010" }], rowCount: 1 };
    }
    if (statement.includes("INSERT INTO exomem_oauth_authorization_codes")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000011" }], rowCount: 1 };
    }
    if (statement.includes("UPDATE exomem_invites")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000001" }], rowCount: 1 };
    }
    if (statement.includes("UPDATE exomem_oauth_authorization_transactions")) {
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000002" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { tx, statements };
}

const INPUT = {
  inviteDigest: Buffer.alloc(32, 1),
  transactionDigest: Buffer.alloc(32, 2),
  sessionDigest: Buffer.alloc(32, 3),
  csrfDigest: Buffer.alloc(32, 4),
  sessionExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
  codeDigest: Buffer.alloc(32, 5),
  codeExpiresAt: new Date("2026-08-25T12:05:00.000Z"),
};

describe("paid operator OAuth admission", () => {
  it("reserves capacity without creating an initial operation for a Paddle invite", async () => {
    const { tx, statements } = admissionSql("paddle");
    __setExomemTransactionForTests(async (work) => work(tx));

    const admitted = await admitFirstOAuthInviteAtomic(INPUT);

    assert.equal(admitted?.operationId, null);
    assert.equal(
      statements.some((statement) => statement.includes("INSERT INTO exomem_lifecycle_operations")),
      false
    );
    const allocation = statements.find((statement) =>
      statement.includes("INSERT INTO exomem_capacity_allocations")
    );
    assert.ok(allocation);
    assert.match(allocation, /'reserved'/i);
  });

  it("keeps complimentary admission on the existing immediate-provision path", async () => {
    const { tx, statements } = admissionSql("complimentary");
    __setExomemTransactionForTests(async (work) => work(tx));

    const admitted = await admitFirstOAuthInviteAtomic(INPUT);

    assert.equal(admitted?.operationId, "018f2d91-7c42-7000-8000-000000000007");
    assert.equal(
      statements.some((statement) => statement.includes("INSERT INTO exomem_lifecycle_operations")),
      true
    );
  });
});
