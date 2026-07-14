import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { verifyHostedSchedulerAuth } from "../scheduler-auth";

const ORIGINAL_HOSTED = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
const ORIGINAL_PREVIOUS = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS;
const ORIGINAL_GLOBAL = process.env.CRON_SECRET;

function request(token?: string) {
  return new Request("https://substratesystems.io/api/cron/exomem-reconcile", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "hosted-scheduler-secret";
  delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS;
  process.env.CRON_SECRET = "global-cron-secret";
});

afterEach(() => {
  if (ORIGINAL_HOSTED === undefined) delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
  else process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = ORIGINAL_HOSTED;
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS;
  else process.env.EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS = ORIGINAL_PREVIOUS;
  if (ORIGINAL_GLOBAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_GLOBAL;
});

describe("verifyHostedSchedulerAuth", () => {
  it("accepts only the dedicated hosted scheduler bearer", () => {
    assert.equal(verifyHostedSchedulerAuth(request("hosted-scheduler-secret")).ok, true);
    assert.equal(verifyHostedSchedulerAuth(request("global-cron-secret")).ok, false);
  });

  it("fails closed when the dedicated secret is absent", () => {
    delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
    assert.equal(verifyHostedSchedulerAuth(request("global-cron-secret")).ok, false);
  });

  it("accepts one explicit previous receiver version during rotation", () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS = "previous-scheduler-secret";
    assert.equal(verifyHostedSchedulerAuth(request("previous-scheduler-secret")).ok, true);
  });
});
