import assert from "node:assert/strict";
import { afterEach, before, describe, it, mock } from "node:test";

type SupporterRow = {
  id: string;
  kind: "founder_notification" | "supporter_thank_you";
  paddle_transaction_id: string;
  customer_email: string | null;
  tier: string;
};

let supporterRows: SupporterRow[] = [];
let tombstones: Array<{ id: string; paddle_subscription_id: string }> = [];
let emailSuccess = true;
let cancellationSuccess = true;
const delivered: string[] = [];
const failedEmails: Array<{ id: string; error: string }> = [];
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
      getSupporterEmailAttentionCount: async () => 0,
      findPendingSupporterEmails: async () => supporterRows,
      findUserById: async () => null,
      markPaddleCancellationAttempt: async (id: string, cancelled: boolean, error?: string) => {
        cancellationAttempts.push({ id, cancelled, error });
        return { attentionRequired: false };
      },
      markSupporterEmailDelivered: async (id: string) => {
        delivered.push(id);
      },
      markSupporterEmailFailed: async (id: string, error: string) => {
        failedEmails.push({ id, error });
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
  supporterRows = [];
  tombstones = [];
  emailSuccess = true;
  cancellationSuccess = true;
  delivered.length = 0;
  failedEmails.length = 0;
  cancellationAttempts.length = 0;
});

function cronRequest(): import("next/server").NextRequest {
  return new Request(
    "https://test.local/api/cron/claim-followups"
  ) as unknown as import("next/server").NextRequest;
}

describe("GET /api/cron/claim-followups durable queues", () => {
  it("records failed supporter delivery and failed Paddle cancellation for a later retry", async () => {
    supporterRows = [
      {
        id: "outbox-1",
        kind: "supporter_thank_you",
        paddle_transaction_id: "txn-1",
        customer_email: "supporter@example.com",
        tier: "patron",
      },
    ];
    tombstones = [{ id: "tombstone-1", paddle_subscription_id: "sub-1" }];
    emailSuccess = false;
    cancellationSuccess = false;
    const { GET } = await import("./route");

    const response = await GET(cronRequest());

    assert.equal(response.status, 200);
    assert.deepEqual(failedEmails, [{ id: "outbox-1", error: "Brevo unavailable" }]);
    assert.deepEqual(cancellationAttempts, [
      {
        id: "tombstone-1",
        cancelled: false,
        error: "Paddle cancellation returned false",
      },
    ]);
    assert.deepEqual(delivered, []);
  });

  it("marks successful delivery and cancellation complete so replays do not resend them", async () => {
    supporterRows = [
      {
        id: "outbox-2",
        kind: "supporter_thank_you",
        paddle_transaction_id: "txn-2",
        customer_email: "supporter@example.com",
        tier: "patron",
      },
    ];
    tombstones = [{ id: "tombstone-2", paddle_subscription_id: "sub-2" }];
    const { GET } = await import("./route");

    const response = await GET(cronRequest());

    assert.equal(response.status, 200);
    assert.deepEqual(delivered, ["outbox-2"]);
    assert.deepEqual(cancellationAttempts, [
      { id: "tombstone-2", cancelled: true, error: undefined },
    ]);
    assert.deepEqual(failedEmails, []);
  });
});
