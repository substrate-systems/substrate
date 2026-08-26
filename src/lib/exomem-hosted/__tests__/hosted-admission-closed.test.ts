import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  redeemInviteAtomic,
  type ExomemSql,
} from "../db";
import { ExomemHostedError, exomemErrors } from "../errors";
import { hasLiveHostedCohortTarget } from "../hosted-cohort-target";

// Production reached this state on 2026-08-17: three `pending` agent-contract
// candidates, none live, no client artifacts. Every invited person who opened
// their link got `500 INTERNAL_ERROR`, because the redemption statement carried
// `1 / (COUNT(*) - COUNT(*))` — an assertion written as a deliberate division by
// zero. It rolled the transaction back correctly and told the person nothing.
// Their invitation was valid the whole time.

const V2 = "EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED";
const COHORT_PROBE = "exomem:live-hosted-cohort-target-exists";
const REDEEM = "exomem:redeem-invite";

const redemptionRow = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  session_id: "session-1",
  operation_id: "operation-1",
};

const params = {
  tokenDigest: Buffer.alloc(32, 1),
  sessionDigest: Buffer.alloc(32, 2),
  csrfDigest: Buffer.alloc(32, 3),
  sessionExpiresAt: new Date("2026-08-18T00:00:00.000Z"),
};

/**
 * Records every statement the redemption issues, classifies a complimentary
 * invite by default, and answers the cohort probe and redemption statements.
 */
function fakeDatabase(options: {
  cohortTargets: number;
  redeemRows: Array<typeof redemptionRow>;
  invitePresent?: boolean;
}): { statements: string[] } {
  const statements: string[] = [];
  const sql: ExomemSql = async (strings) => {
    const statement = strings.join("?");
    statements.push(statement);
    await Promise.resolve();
    if (statement.includes(COHORT_PROBE)) {
      return { rows: Array.from({ length: options.cohortTargets }, () => ({ id: "candidate-1" })) };
    }
    if (/^\s*SELECT id, email_normalized, entitlement_source/.test(statement)) {
      return options.invitePresent === false
        ? { rows: [], rowCount: 0 }
        : {
            rows: [
              {
                id: "invite-1",
                email_normalized: "ordinary@example.test",
                entitlement_source: "complimentary",
                entitlement_capabilities: [],
                entitlement_limits: {},
                marketplace_reviewer_purpose: false,
              },
            ],
            rowCount: 1,
          };
    }
    if (statement.includes(REDEEM)) {
      return { rows: options.redeemRows, rowCount: options.redeemRows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  __setExomemSqlForTests(sql);
  __setExomemTransactionForTests(async (work) => work(sql));
  return { statements };
}

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
  delete process.env[V2];
});

describe("a closed Hosted cohort refuses in the open", () => {
  it("names the reason instead of crashing when no cohort is live", async () => {
    process.env[V2] = "true";
    fakeDatabase({ cohortTargets: 0, redeemRows: [] });

    const error = await redeemInviteAtomic(params).then(
      () => null,
      (thrown: unknown) => thrown
    );

    assert.ok(error instanceof ExomemHostedError);
    assert.equal(error.code, "HOSTED_ADMISSION_CLOSED");
    assert.equal(error.status, 503);
    // Not 401 ACCESS_TOKEN_INVALID and not a bare 500: the invitation is fine.
    assert.notEqual(error.code, "ACCESS_TOKEN_INVALID");
  });

  it("leaves the invitation untouched, having issued no write at all", async () => {
    process.env[V2] = "true";
    const { statements } = fakeDatabase({ cohortTargets: 0, redeemRows: [] });

    await redeemInviteAtomic(params).catch(() => undefined);

    // The redemption statement's owner, tenant, entitlement and session CTEs all
    // modify data, and PostgreSQL runs a data-modifying CTE whether or not the
    // primary query reads it. Refusing before the statement is what keeps a
    // half-built tenant from existing at all.
    assert.ok(!statements.some((statement) => statement.includes(REDEEM)));
    assert.ok(statements.some((statement) => statement.includes(COHORT_PROBE)));
  });

  it("still redeems normally when a cohort is live", async () => {
    process.env[V2] = "true";
    fakeDatabase({ cohortTargets: 1, redeemRows: [redemptionRow] });

    const redeemed = await redeemInviteAtomic(params);

    assert.deepEqual(redeemed, {
      userId: "user-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      operationId: "operation-1",
    });
  });

  it("reports an invalid link as an invalid link, not as a closed cohort", async () => {
    process.env[V2] = "true";
    fakeDatabase({ cohortTargets: 1, redeemRows: [], invitePresent: false });

    // An invalid token returns before cohort admission is relevant and before
    // any modifying CTE can run.
    assert.equal(await redeemInviteAtomic(params), null);
  });

  it("aborts rather than commit a tenant whose target vanished mid-transaction", async () => {
    process.env[V2] = "true";
    let probes = 0;
    const sql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      await Promise.resolve();
      if (statement.includes(COHORT_PROBE)) {
        probes += 1;
        // Live at the pre-check, gone by the time the statement returned.
        return { rows: probes === 1 ? [{ id: "candidate-1" }] : [] };
      }
      if (/^\s*SELECT id, email_normalized, entitlement_source/.test(statement)) {
        return {
          rows: [
            {
              id: "invite-1",
              email_normalized: "ordinary@example.test",
              entitlement_source: "complimentary",
              entitlement_capabilities: [],
              entitlement_limits: {},
              marketplace_reviewer_purpose: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    // Returning null here would commit the owner, tenant and session rows with
    // no provision operation pinned to them.
    await assert.rejects(redeemInviteAtomic(params), (error: unknown) => {
      assert.ok(error instanceof ExomemHostedError);
      assert.equal(error.code, "HOSTED_ADMISSION_CLOSED");
      return true;
    });
    assert.equal(probes, 2);
  });

  it("does not consult the cohort under v1, which pins no contract", async () => {
    const { statements } = fakeDatabase({ cohortTargets: 0, redeemRows: [redemptionRow] });

    const redeemed = await redeemInviteAtomic(params);

    assert.equal(redeemed?.tenantId, "tenant-1");
    assert.ok(!statements.some((statement) => statement.includes(COHORT_PROBE)));
  });
});

describe("the refusal is legible to the person holding the invitation", () => {
  it("is retryable and says the invitation survives", () => {
    const error = exomemErrors.admissionClosed();
    const envelope = error.toJSON();

    assert.equal(envelope.code, "HOSTED_ADMISSION_CLOSED");
    assert.equal(envelope.retryable, true);
    assert.match(String(envelope.remediation), /still valid/i);
    assert.match(String(envelope.remediation), /not been used/i);
  });
});

describe("both admission paths refuse the same way", () => {
  const source = (file: string): string =>
    readFileSync(resolve(process.cwd(), "src/lib/exomem-hosted", file), "utf8");

  it("has no arithmetic assertion left in the redemption statement", async () => {
    process.env[V2] = "true";
    const { statements } = fakeDatabase({ cohortTargets: 1, redeemRows: [redemptionRow] });

    await redeemInviteAtomic(params);

    // The exact defect: a guard that could only be expressed as a crash. Asserted
    // against the SQL actually issued, not the file, so the comment recording
    // what used to be here does not satisfy its own regression test.
    const redeem = statements.find((statement) => statement.includes(REDEEM));
    assert.ok(redeem);
    assert.doesNotMatch(redeem, /1 \/ \(COUNT\(\*\) - COUNT\(\*\)\)/);
    assert.doesNotMatch(redeem, /target_guard/);
    // What replaced it is the shape the OAuth path already used.
    assert.match(redeem, /FROM live_target\s+WHERE/);
  });

  it("routes OAuth first-owner admission to the same code", () => {
    // The OAuth path already aborted cleanly, but reported the closed cohort as
    // `ACCESS_TOKEN_INVALID` — "the access link is invalid or unavailable" —
    // which is the same lie told more politely.
    const oauthStore = source("oauth-store.ts");
    assert.match(oauthStore, /class OAuthAdmissionCohortClosed/);
    assert.match(oauthStore, /hasLiveHostedCohortTarget/);
    assert.match(
      oauthStore,
      /OAuthAdmissionCohortClosed\) throw exomemErrors\.admissionClosed\(\)/
    );
  });
});

describe("the cohort probe asks exactly what the target CTEs ask", () => {
  it("is true only when one candidate is live on one gateway contract digest", async () => {
    const answer = async (rowCount: number): Promise<boolean> =>
      hasLiveHostedCohortTarget((async () => ({
        rows: Array.from({ length: rowCount }, () => ({ id: "c" })),
      })) as ExomemSql);

    assert.equal(await answer(0), false);
    assert.equal(await answer(1), true);
    // Two live candidates is as unroutable as none: nothing selects between them.
    assert.equal(await answer(2), false);
  });

  it("pins the same predicates the redemption statement selects on", async () => {
    let statement = "";
    const values: unknown[] = [];
    await hasLiveHostedCohortTarget((async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      statement = strings.join("?");
      values.push(...parameters);
      return { rows: [] };
    }) as ExomemSql);

    for (const predicate of [
      /candidate\.profile_id = \?/,
      /candidate\.state = 'live'/,
      /catalog_cell\.routing_state = 'bound'/,
      /observed_command_fingerprint = candidate\.command_fingerprint/,
      /observed_schema_digest = candidate\.schema_digest/,
      /HAVING COUNT\(DISTINCT catalog_cell\.observed_gateway_contract_digest\) = 1/,
    ]) {
      assert.match(statement, predicate);
    }
    assert.equal(values.includes("hosted-alpha-agent-v4"), true);
  });
});
