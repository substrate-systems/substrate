import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ADMISSION_CLOSURE_REASONS,
  ADMISSION_CLOSURE_SITES,
  ExomemHostedError,
  exomemErrors,
  type OperatorErrorDetail,
} from "../errors";
import { accessErrorResponse } from "../http";
import { setOperationalEventSinkForTests } from "../observability";

/**
 * The denial log is the only place an operator sees an admission refusal: the
 * refused person's payload cannot name the cause, and there is no operator
 * endpoint for a redemption. Before this, `HOSTED_ADMISSION_CLOSED` was not even
 * in the allowed error-code set, so `buildOperationalEvent` dropped it and the
 * line said `access.request.denied` with no code at all.
 */
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function capture(error: unknown): Record<string, unknown> {
  const lines: string[] = [];
  setOperationalEventSinkForTests((line) => lines.push(line));
  try {
    accessErrorResponse({ error, event: "access.request.denied", requestId: REQUEST_ID });
  } finally {
    setOperationalEventSinkForTests(null);
  }
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

afterEach(() => setOperationalEventSinkForTests(null));

describe("the denial log names the closure and its remedy", () => {
  it("carries the code, the reason, the site and the bootstrap procedure", () => {
    const event = capture(
      exomemErrors.admissionClosed({
        reason: "no_live_candidate",
        site: "invite_redemption_precheck",
      })
    );

    assert.equal(event.errorCode, "HOSTED_ADMISSION_CLOSED");
    assert.equal(event.closureReason, "no_live_candidate");
    assert.equal(event.closureSite, "invite_redemption_precheck");
    assert.equal(event.closureProcedure, "virgin-install-reviewer-oauth-bootstrap");
  });

  it("does not send an operator to the bootstrap for a cohort that was live", () => {
    const event = capture(
      exomemErrors.admissionClosed({
        reason: "live_cohort_lost",
        site: "invite_redemption_settlement",
      })
    );

    assert.equal(event.errorCode, "HOSTED_ADMISSION_CLOSED");
    assert.equal(event.closureReason, "live_cohort_lost");
    assert.equal(event.closureSite, "invite_redemption_settlement");
    assert.equal(event.closureProcedure, undefined);
    assert.doesNotMatch(JSON.stringify(event), /virgin-install|bootstrap/i);
  });

  // `buildOperationalEvent` drops any label outside its allow-list, silently. A
  // reason that never reaches the log is a reason no operator will ever read, so
  // every member of the taxonomy is walked rather than the two that were written
  // by hand when it had two members.
  it("carries every reason and every site the taxonomy defines", () => {
    for (const reason of ADMISSION_CLOSURE_REASONS) {
      for (const site of ADMISSION_CLOSURE_SITES) {
        const event = capture(exomemErrors.admissionClosed({ reason, site }));
        assert.equal(event.closureReason, reason, `${reason} was dropped from the denial log`);
        assert.equal(event.closureSite, site, `${site} was dropped from the denial log`);
        assert.equal(event.errorCode, "HOSTED_ADMISSION_CLOSED");
      }
    }
  });

  it("leaves an unrelated denial exactly as it was", () => {
    const event = capture(exomemErrors.accessTokenInvalid());

    assert.equal(event.errorCode, "ACCESS_TOKEN_INVALID");
    assert.equal(event.closureReason, undefined);
    assert.equal(event.closureSite, undefined);
    assert.equal(event.closureProcedure, undefined);
  });

  /**
   * `operatorDetail` is newly public and spread into this event's input, so the
   * question is not whether anything sends a hostile one today — nothing does —
   * but what happens the first time something can. `OperatorErrorDetail` closes
   * the key space; this is the second guard, for a caller that got past it.
   *
   * `outcome` is the sharp one. Only four values are legal, so poisoning it
   * makes `buildOperationalEvent` throw out of `accessErrorResponse` — turning
   * a clean 503 "your invitation is still valid" into the unhandled 500 this
   * work exists to eliminate.
   */
  it("cannot be forged or derailed by a hostile operator detail", () => {
    const hostile = new ExomemHostedError({
      code: "HOSTED_ADMISSION_CLOSED",
      status: 503,
      message: "hosted admission is temporarily closed",
      operatorDetail: {
        event: "mcp.request",
        outcome: "not-an-outcome",
        errorCode: "ACCESS_TOKEN_INVALID",
        requestId: "99999999-9999-4999-8999-999999999999",
        closureReason: "no_live_candidate",
      } as unknown as OperatorErrorDetail,
    });

    const event = capture(hostile);

    assert.equal(event.event, "access.request.denied");
    assert.equal(event.outcome, "denied");
    assert.equal(event.errorCode, "HOSTED_ADMISSION_CLOSED");
    assert.equal(event.requestId, REQUEST_ID);
    // The one field it may legitimately contribute still arrives.
    assert.equal(event.closureReason, "no_live_candidate");
  });
});
