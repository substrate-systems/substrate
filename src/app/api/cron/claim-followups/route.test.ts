import assert from "node:assert/strict";
import { afterEach, before, describe, it, mock } from "node:test";

let tombstones: Array<{ id: string; paddle_subscription_id: string }> = [];
let emailSuccess = true;
let cancellationSuccess = true;
const cancellationAttempts: Array<{ id: string; cancelled: boolean; error?: string }> = [];

before(() => {
  mock.module("@/lib/hosted-backup/cron-auth", {
    namedExports: { verifyCronAuth: () => ({ ok: true }) },
  });
  mock.module("@/lib/analytics-server", {
    namedExports: { captureCronOutcome: async () => undefined },
  });
  mock.module("@/lib/hosted-backup/claim-tokens", {
    namedExports: {
      findFounderAlertableClaims: async () => [],
      findResendableClaims: async () => [],
      markCronResent: async () => undefined,
      markFounderAlerted: async () => undefined,
    },
  });
  mock.module("@/lib/hosted-backup/db", {
    namedExports: {
      findPendingPaddleCancellations: async () => tombstones,
      getPaddleCancellationAttentionCount: async () => 0,
      findUserById: async () => null,
      markPaddleCancellationAttempt: async (id: string, cancelled: boolean, error?: string) => {
        cancellationAttempts.push({ id, cancelled, error });
        return { attentionRequired: false };
      },
    },
  });
  mock.module("@/lib/hosted-backup/subscriptions", {
    namedExports: { cancelPaddleSubscription: async () => cancellationSuccess },
  });
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async () =>
        emailSuccess
          ? { success: true, messageId: "msg-test" }
          : { success: false, error: "Brevo unavailable" },
    },
  });
  mock.module("@/lib/email-templates/claim", {
    namedExports: {
      renderFounderDigest: () => ({ subject: "digest", htmlContent: "", textContent: "" }),
      renderResendClaimEmail: () => ({ subject: "claim", htmlContent: "", textContent: "" }),
    },
  });
});

afterEach(() => {
  tombstones = [];
  emailSuccess = true;
  cancellationSuccess = true;
  cancellationAttempts.length = 0;
});

function cronRequest(): import("next/server").NextRequest {
  return new Request(
    "https://test.local/api/cron/claim-followups"
  ) as unknown as import("next/server").NextRequest;
}

describe("GET /api/cron/claim-followups durable queues", () => {
  it("records a failed Paddle cancellation for a later retry", async () => {
    tombstones = [{ id: "tombstone-1", paddle_subscription_id: "sub-1" }];
    emailSuccess = false;
    cancellationSuccess = false;
    const { GET } = await import("./route");

    const response = await GET(cronRequest());

    assert.equal(response.status, 200);
    assert.deepEqual(cancellationAttempts, [
      {
        id: "tombstone-1",
        cancelled: false,
        error: "Paddle cancellation returned false",
      },
    ]);
  });

  it("marks a successful cancellation complete so replays do not repeat it", async () => {
    tombstones = [{ id: "tombstone-2", paddle_subscription_id: "sub-2" }];
    const { GET } = await import("./route");

    const response = await GET(cronRequest());

    assert.equal(response.status, 200);
    assert.deepEqual(cancellationAttempts, [
      { id: "tombstone-2", cancelled: true, error: undefined },
    ]);
  });

  it("no longer drains a supporter mail outbox", async () => {
    tombstones = [];
    const { GET } = await import("./route");

    const body = (await (await GET(cronRequest())).json()) as Record<string, unknown>;

    assert.equal("supporterEmailsSent" in body, false);
    assert.equal("supporterEmailsAttentionRequired" in body, false);
    assert.equal("paddleCancellationsCompleted" in body, true);
  });
});
