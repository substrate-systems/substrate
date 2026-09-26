import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import { runBoundedCloudDeletionFinish, timeoutTransport } from "../cloud-deletion-finish";
import type { PaddleTransport } from "../paddle-billing";

// L1: the finish lane carries its own time budget (checked between tenants,
// the same way the other reconcile lanes carry `timeBudgetMs`), and the
// billing calls it makes by default carry a request timeout, so neither a
// stalled Paddle connection nor an oversized population can hold the lane
// open past the cron caller's own client timeout.

describe("Cloud deletion finish lane budget", () => {
  it("L1: stops at the deadline and reports every tenant it never reached as pending", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [{ id: "tenant-a" }, { id: "tenant-b" }, { id: "tenant-c" }],
    }));
    try {
      const times = [0, 0, 900]; // started, before tenant-a, before tenant-b (over budget)
      const attempted: string[] = [];
      const result = await runBoundedCloudDeletionFinish({
        timeBudgetMs: 800,
        now: () => times.shift() ?? 900,
        finishTenant: async (tenantId) => {
          attempted.push(tenantId);
          return "finished";
        },
      });
      assert.deepEqual(attempted, ["tenant-a"]);
      assert.deepEqual(result, { finished: 1, pending: 2, failed: 0 });
    } finally {
      __setExomemSqlForTests(null);
    }
  });

  it("L1: runs every tenant when comfortably inside the budget", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [{ id: "tenant-a" }, { id: "tenant-b" }],
    }));
    try {
      const attempted: string[] = [];
      const result = await runBoundedCloudDeletionFinish({
        timeBudgetMs: 8_000,
        now: () => 0,
        finishTenant: async (tenantId) => {
          attempted.push(tenantId);
          return tenantId === "tenant-a" ? "finished" : "billing_pending";
        },
      });
      assert.deepEqual(attempted, ["tenant-a", "tenant-b"]);
      assert.deepEqual(result, { finished: 1, pending: 1, failed: 0 });
    } finally {
      __setExomemSqlForTests(null);
    }
  });

  it("L1: wraps the transport with an abort signal budget without dropping the rest of init", async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown; hasSignal: boolean }> = [];
    const inner: PaddleTransport = async (path, init) => {
      calls.push({
        path,
        method: init?.method,
        body: init?.body,
        hasSignal: init?.signal instanceof AbortSignal,
      });
      return new Response(null, { status: 200 });
    };
    const wrapped = timeoutTransport(inner, 5_000);
    await wrapped("/subscriptions/sub_x/cancel", {
      method: "POST",
      body: JSON.stringify({ effective_from: "immediately" }),
    });
    assert.deepEqual(calls, [
      {
        path: "/subscriptions/sub_x/cancel",
        method: "POST",
        body: JSON.stringify({ effective_from: "immediately" }),
        hasSignal: true,
      },
    ]);
  });
});
