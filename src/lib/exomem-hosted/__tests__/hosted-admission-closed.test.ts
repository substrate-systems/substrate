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
import {
  ADMISSION_CLOSURE_REASONS,
  ExomemHostedError,
  exomemErrors,
  safeErrorEnvelope,
} from "../errors";
import {
  HOSTED_COHORT_CLOSURE_REASONS,
  hasLiveHostedCohortTarget,
  probeHostedCohortTarget,
} from "../hosted-cohort-target";

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
 * Every fleet state the cohort probe can tell apart, as the aggregate row its
 * single statement returns: how many candidates are live for the profile, how
 * many of those have bound cells agreeing on one gateway contract digest, and
 * how many have bound cells that disagree.
 *
 * Three of the four are closures, and each is named for the reason the probe
 * must report for it. `routable` is the state that admits.
 */
const COHORT_STATES = {
  no_live_candidate: { live_candidates: 0, routable_targets: 0, disagreeing_candidates: 0 },
  no_bound_cell_for_live_candidate: {
    live_candidates: 1,
    routable_targets: 0,
    disagreeing_candidates: 0,
  },
  bound_cells_disagree_on_contract: {
    live_candidates: 1,
    routable_targets: 0,
    disagreeing_candidates: 1,
  },
  routable: { live_candidates: 1, routable_targets: 1, disagreeing_candidates: 0 },
} as const;
type CohortState = keyof typeof COHORT_STATES;

/**
 * Records every statement the redemption issues, classifies a complimentary
 * invite by default, and answers the cohort probe and redemption statements.
 */
function fakeDatabase(options: {
  cohort: CohortState;
  redeemRows: Array<typeof redemptionRow>;
  invitePresent?: boolean;
}): { statements: string[] } {
  const statements: string[] = [];
  const sql: ExomemSql = async (strings) => {
    const statement = strings.join("?");
    statements.push(statement);
    await Promise.resolve();
    if (statement.includes(COHORT_PROBE)) {
      return { rows: [COHORT_STATES[options.cohort]] };
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
    fakeDatabase({ cohort: "no_live_candidate", redeemRows: [] });

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
    const { statements } = fakeDatabase({ cohort: "no_live_candidate", redeemRows: [] });

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
    fakeDatabase({ cohort: "routable", redeemRows: [redemptionRow] });

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
    fakeDatabase({ cohort: "routable", redeemRows: [], invitePresent: false });

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
        return {
          rows: [COHORT_STATES[probes === 1 ? "routable" : "no_live_candidate"]],
        };
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
    const { statements } = fakeDatabase({
      cohort: "no_live_candidate",
      redeemRows: [redemptionRow],
    });

    const redeemed = await redeemInviteAtomic(params);

    assert.equal(redeemed?.tenantId, "tenant-1");
    assert.ok(!statements.some((statement) => statement.includes(COHORT_PROBE)));
  });
});

describe("the refusal is legible to the person holding the invitation", () => {
  it("is retryable and says the invitation survives", () => {
    const error = exomemErrors.admissionClosed({
      reason: "no_live_candidate",
      site: "invite_redemption_precheck",
    });
    const envelope = error.toJSON();

    assert.equal(envelope.code, "HOSTED_ADMISSION_CLOSED");
    assert.equal(envelope.retryable, true);
    assert.match(String(envelope.remediation), /still valid/i);
    assert.match(String(envelope.remediation), /not been used/i);
  });
});

// `HOSTED_ADMISSION_CLOSED` is one public code over several closures that want
// different actions. Three are states of the fleet, told apart by the probe:
// nothing was ever promoted (bootstrap), a candidate is live with nothing bound
// to serve it, and bound cells that disagree about the contract — the last being
// an ordinary state part way through a rotation. One more is inferred rather
// than probed: a target that was live at the pre-check and gone by the
// settlement. The invited person cannot act on any of it and must not be told
// it; the operator can act on nothing else.
describe("the closed cohort classifies itself for the operator", () => {
  // Everything the refused person must never learn. `catalogue` is deliberately
  // absent: the public copy already says the service catalogue is being
  // updated, which is true and names nothing.
  const FLEET_NOUNS = /tenant|cohort|candidate|fleet|cell|bootstrap|runbook|virgin-install/i;

  it("classifies an empty fleet as no-live-candidate and names the bootstrap", async () => {
    process.env[V2] = "true";
    fakeDatabase({ cohort: "no_live_candidate", redeemRows: [] });

    const error = await redeemInviteAtomic(params).then(
      () => null,
      (thrown: unknown) => thrown
    );

    assert.ok(error instanceof ExomemHostedError);
    const operator = error.operatorDetail;
    assert.ok(operator, "an admission refusal must carry its classification");
    assert.equal(operator.closureReason, "no_live_candidate");
    assert.equal(operator.closureSite, "invite_redemption_precheck");
    assert.equal(operator.closureProcedure, "virgin-install-reviewer-oauth-bootstrap");
    assert.match(String(operator.closureRunbook), /exomem-hosted-alpha\.md#/);
  });

  // The defect this replaced: every closed state was reported as the empty
  // fleet, so an operator part way through an ordinary rotation was sent to a
  // procedure that builds a second reviewer-purpose tenant.
  for (const cohort of [
    "no_bound_cell_for_live_candidate",
    "bound_cells_disagree_on_contract",
  ] as const) {
    it(`refuses a fleet in ${cohort} without offering the bootstrap`, async () => {
      process.env[V2] = "true";
      fakeDatabase({ cohort, redeemRows: [] });

      const error = await redeemInviteAtomic(params).then(
        () => null,
        (thrown: unknown) => thrown
      );

      assert.ok(error instanceof ExomemHostedError);
      assert.equal(error.code, "HOSTED_ADMISSION_CLOSED");
      const operator = error.operatorDetail;
      assert.equal(operator?.closureReason, cohort);
      assert.equal(operator?.closureSite, "invite_redemption_precheck");
      assert.equal(operator?.closureProcedure, undefined);
      assert.equal(operator?.closureRunbook, undefined);
      assert.doesNotMatch(JSON.stringify(operator), /virgin-install|bootstrap/i);
    });
  }

  it("tells the refused person none of it", async () => {
    process.env[V2] = "true";
    fakeDatabase({ cohort: "no_live_candidate", redeemRows: [] });

    const error = await redeemInviteAtomic(params).then(
      () => null,
      (thrown: unknown) => thrown
    );

    assert.ok(error instanceof ExomemHostedError);
    // What actually crosses the wire, not the error object.
    const payload = JSON.stringify(
      safeErrorEnvelope(error, "11111111-1111-4111-8111-111111111111")
    );
    assert.doesNotMatch(payload, FLEET_NOUNS);
    assert.doesNotMatch(payload, /operatorDetail|closure[A-Z]/);
    assert.doesNotMatch(payload, /docs\/runbooks/);
    // And the copy the person needs is still there, unchanged in substance.
    assert.match(payload, /still valid/i);
    assert.match(payload, /has not been used/i);

    // `safeErrorEnvelope` is not the only public surface. `JSON.stringify` on
    // the error itself routes through `toJSON`, which several callers reach —
    // and which a leak guard aimed only at the envelope does not cover. Asserted
    // separately because the two functions can drift apart: adding
    // `...this.operatorDetail` to `toJSON` leaves every envelope test green.
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, FLEET_NOUNS);
    assert.doesNotMatch(serialized, /operatorDetail|closure[A-Z]/);
    assert.doesNotMatch(serialized, /docs\/runbooks/);
    assert.match(serialized, /still valid/i);
  });

  it("leaves the invitation unconsumed, having written nothing at all", async () => {
    process.env[V2] = "true";
    const { statements } = fakeDatabase({ cohort: "no_live_candidate", redeemRows: [] });

    await redeemInviteAtomic(params).catch(() => undefined);

    for (const statement of statements) {
      // `FOR UPDATE` is a read lock, not a write; everything else is.
      const writes = statement.replace(/FOR UPDATE/gi, "");
      assert.doesNotMatch(writes, /\b(INSERT|UPDATE|DELETE)\b/i);
      assert.doesNotMatch(writes, /consumed_at\s*=|revoked_at\s*=/i);
    }
  });

  it("classifies a target lost after the pre-check as a different cause, without the bootstrap", async () => {
    process.env[V2] = "true";
    let probes = 0;
    const sql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      await Promise.resolve();
      if (statement.includes(COHORT_PROBE)) {
        probes += 1;
        return {
          rows: [COHORT_STATES[probes === 1 ? "routable" : "no_live_candidate"]],
        };
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

    const error = await redeemInviteAtomic(params).then(
      () => null,
      (thrown: unknown) => thrown
    );

    assert.ok(error instanceof ExomemHostedError);
    const operator = error.operatorDetail;
    assert.ok(operator);
    // A cohort that was live and is not is not a virgin install, and sending an
    // operator to the bootstrap would have them build a second reviewer tenant
    // for a fleet that already had one.
    assert.equal(operator.closureReason, "live_cohort_lost");
    assert.equal(operator.closureSite, "invite_redemption_settlement");
    assert.equal(operator.closureProcedure, undefined);
    assert.equal(operator.closureRunbook, undefined);
    assert.doesNotMatch(JSON.stringify(operator), /virgin-install|bootstrap/i);
  });

  it("gives each of the three refusal sites its own classification", () => {
    const sites = [
      { reason: "no_live_candidate", site: "invite_redemption_precheck" },
      { reason: "live_cohort_lost", site: "invite_redemption_settlement" },
      { reason: "no_live_candidate", site: "oauth_first_owner_admission" },
    ] as const;

    const classifications = sites.map((closure) =>
      JSON.stringify(exomemErrors.admissionClosed(closure).operatorDetail)
    );

    assert.equal(new Set(classifications).size, 3);
    // The public code is the same for all three on purpose: the refused person
    // cannot act on the difference, and every client would have to learn it.
    for (const closure of sites) {
      assert.equal(exomemErrors.admissionClosed(closure).code, "HOSTED_ADMISSION_CLOSED");
    }
  });

  it("points at a procedure that is actually written down", () => {
    const operator = exomemErrors.admissionClosed({
      reason: "no_live_candidate",
      site: "invite_redemption_precheck",
    }).operatorDetail;
    const [path, anchor] = String(operator?.closureRunbook).split("#");

    // A remedy pointer that has rotted is worse than none: it sends whoever is
    // holding the outage to a heading that no longer exists.
    const runbook = readFileSync(resolve(process.cwd(), path), "utf8");
    const headings = runbook
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .map((line) =>
        line
          .replace(/^#+\s*/, "")
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, "")
          .replaceAll(" ", "-")
      );
    assert.ok(headings.includes(anchor), `${path} has no heading anchored at #${anchor}`);
    assert.equal(anchor, operator?.closureProcedure);
  });
});

describe("both admission paths refuse the same way", () => {
  const source = (file: string): string =>
    readFileSync(resolve(process.cwd(), "src/lib/exomem-hosted", file), "utf8");

  it("has no arithmetic assertion left in the redemption statement", async () => {
    process.env[V2] = "true";
    const { statements } = fakeDatabase({ cohort: "routable", redeemRows: [redemptionRow] });

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
    // The same probe, so the OAuth refusal names the same closure the redemption
    // pre-check would have named for the same fleet.
    assert.match(oauthStore, /probeHostedCohortTarget/);
    assert.match(
      oauthStore,
      /OAuthAdmissionCohortClosed\)\s*\n?\s*throw exomemErrors\.admissionClosed\(/
    );
  });
});

describe("the cohort probe asks exactly what the target CTEs ask", () => {
  const answering = (state: CohortState): ExomemSql =>
    (async () => ({ rows: [COHORT_STATES[state]] })) as ExomemSql;

  it("is true only when one candidate is live on one gateway contract digest", async () => {
    assert.equal(await hasLiveHostedCohortTarget(answering("routable")), true);
    assert.equal(await hasLiveHostedCohortTarget(answering("no_live_candidate")), false);
    assert.equal(
      await hasLiveHostedCohortTarget(answering("no_bound_cell_for_live_candidate")),
      false
    );
    assert.equal(
      await hasLiveHostedCohortTarget(answering("bound_cells_disagree_on_contract")),
      false
    );
    // Two routable candidates is as unroutable as none: nothing selects between
    // them. `exomem_agent_contract_candidates_one_live_idx` makes the state
    // unreachable, and the decision refuses it anyway.
    assert.equal(
      await hasLiveHostedCohortTarget((async () => ({
        rows: [{ live_candidates: 2, routable_targets: 2, disagreeing_candidates: 0 }],
      })) as ExomemSql),
      false
    );
  });

  it("pins the same predicates the redemption statement selects on", async () => {
    let statement = "";
    const values: unknown[] = [];
    await hasLiveHostedCohortTarget((async (
      strings: TemplateStringsArray,
      ...parameters: unknown[]
    ) => {
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
      // The routable count is the old `HAVING COUNT(DISTINCT …) = 1` moved into
      // an aggregate, so the classification and the decision share one snapshot.
      /COUNT\(\*\) FILTER \(WHERE contract_digests = 1\)::int AS routable_targets/,
    ]) {
      assert.match(statement, predicate);
    }
    assert.equal(values.includes("hosted-alpha-agent-v4"), true);
  });

  // The reviewer's constraint on this change: the classification is added
  // alongside the decision and may not move it by one row. These pin the
  // decision against every state the probe distinguishes; the real-PostgreSQL
  // proof, against the pre-change query run verbatim as an oracle, is
  // `postgres.integration.test.ts`.
  it("decides identically in every state it now classifies", async () => {
    const decisions: Array<[CohortState, boolean, string | undefined]> = [];
    for (const state of Object.keys(COHORT_STATES) as CohortState[]) {
      const probe = await probeHostedCohortTarget(answering(state));
      decisions.push([
        state,
        await hasLiveHostedCohortTarget(answering(state)),
        probe.live ? undefined : probe.reason,
      ]);
    }

    assert.deepEqual(decisions, [
      ["no_live_candidate", false, "no_live_candidate"],
      ["no_bound_cell_for_live_candidate", false, "no_bound_cell_for_live_candidate"],
      ["bound_cells_disagree_on_contract", false, "bound_cells_disagree_on_contract"],
      ["routable", true, undefined],
    ]);
  });

  it("proves every closure reason it is allowed to report", async () => {
    const proved = new Set<string>();
    for (const state of Object.keys(COHORT_STATES) as CohortState[]) {
      const probe = await probeHostedCohortTarget(answering(state));
      if (!probe.live) proved.add(probe.reason);
    }

    assert.deepEqual([...proved].sort(), [...HOSTED_COHORT_CLOSURE_REASONS].sort());
  });
});

describe("a remedy is only offered for a closure that was established", () => {
  const detailFor = (reason: (typeof ADMISSION_CLOSURE_REASONS)[number]) =>
    exomemErrors.admissionClosed({ reason, site: "invite_redemption_precheck" }).operatorDetail;

  it("attaches a procedure only to a reason the probe can prove", async () => {
    const proved = new Set<string>();
    for (const state of Object.keys(COHORT_STATES) as CohortState[]) {
      const probe = await probeHostedCohortTarget((async () => ({
        rows: [COHORT_STATES[state]],
      })) as ExomemSql);
      if (!probe.live) proved.add(probe.reason);
    }

    const carriesRemedy = ADMISSION_CLOSURE_REASONS.filter((reason) => {
      const detail = detailFor(reason);
      return Boolean(detail?.closureProcedure ?? detail?.closureRunbook);
    });

    assert.ok(carriesRemedy.length > 0, "a taxonomy that points nowhere helps nobody");
    for (const reason of carriesRemedy) {
      // A procedure is an instruction to act. Offering one for a state nothing
      // established is the defect this taxonomy replaced, wearing a finer label:
      // "admission is shut" was read as "the fleet is empty" and sent an
      // operator to build a second reviewer tenant.
      assert.ok(
        proved.has(reason),
        `${reason} offers a procedure, but no probe state produces that reason`
      );
    }
  });

  it("says something true about every closure, remedy or not", () => {
    for (const reason of ADMISSION_CLOSURE_REASONS) {
      const detail = detailFor(reason);
      assert.equal(detail?.closureReason, reason);
      assert.ok(String(detail?.closureSummary).length > 0);
      // A runbook link without a procedure, or the reverse, is a half-answer.
      assert.equal(
        detail?.closureProcedure === undefined,
        detail?.closureRunbook === undefined,
        `${reason} names a procedure and a runbook inconsistently`
      );
    }
  });
});
