import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptionProposalContext,
  adoptionRunStatus,
  adoptionWorkItem,
  applyAdoptionPlan,
  approveAdoptionProposal,
  cancelAdoptionRun,
  finishAdoptionRun,
  listAdoptionProposals,
  planAdoptionRun,
  rejectAdoptionProposal,
  retryAdoptionApply,
  selectAdoptionScope,
  startAdoptionRun,
} from "../hosted-browser";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RecordedCall = { url: string; body: Record<string, unknown>; headers: Headers };

function withAdoptionFetch(
  context: { after: (callback: () => void) => void },
  calls: RecordedCall[]
): void {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  globalThis.fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: new Headers(init.headers),
    });
    return Response.json({ success: true, data: { run_id: "run-1" } });
  };
}

test("adoption run commands post the engine's exact action payloads", async (context) => {
  const calls: RecordedCall[] = [];
  withAdoptionFetch(context, calls);

  await startAdoptionRun({ path: "_Staging/adoption/run-1" }, "retry-start");
  await selectAdoptionScope(
    "run-1",
    {
      include: ["Docs"],
      exclude: ["Docs/tmp"],
      overrides: ["Docs/tmp/keep.md"],
      includeJunk: false,
    },
    "retry-select"
  );
  await planAdoptionRun("run-1", "retry-plan");
  await applyAdoptionPlan("run-1", "plan-9", "retry-apply");
  await retryAdoptionApply("run-1", "plan-9", ["Docs/failed.md"], "retry-retry");
  await cancelAdoptionRun("run-1", "changed my mind", "retry-cancel");
  await finishAdoptionRun("run-1", "retry-finish");

  for (const call of calls) {
    assert.equal(call.url, "/api/exomem/commands/adoption_studio");
    assert.equal(call.headers.get("x-exomem-csrf"), "csrf-token");
    assert.equal(call.headers.get("content-type"), "application/json");
  }
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { action: "start", path: "_Staging/adoption/run-1", initialize_kb: false },
      {
        action: "select",
        run_id: "run-1",
        include: ["Docs"],
        exclude: ["Docs/tmp"],
        overrides: ["Docs/tmp/keep.md"],
        include_junk: false,
      },
      { action: "plan", run_id: "run-1" },
      { action: "apply", run_id: "run-1", plan_id: "plan-9" },
      {
        action: "apply",
        run_id: "run-1",
        plan_id: "plan-9",
        retry_failed: true,
        only_paths: ["Docs/failed.md"],
      },
      { action: "cancel", run_id: "run-1", why: "changed my mind" },
      { action: "finish", run_id: "run-1" },
    ]
  );
  assert.deepEqual(
    calls.map((call) => call.headers.get("idempotency-key")),
    [
      "retry-start",
      "retry-select",
      "retry-plan",
      "retry-apply",
      "retry-retry",
      "retry-cancel",
      "retry-finish",
    ]
  );
});

test("start can initialize a fresh KB and retry sends only_paths null when empty", async (context) => {
  const calls: RecordedCall[] = [];
  withAdoptionFetch(context, calls);

  await startAdoptionRun({ path: "_Staging/adoption/run-2", initializeKb: true }, "retry-start");
  await retryAdoptionApply("run-2", "plan-1", [], "retry-retry");
  await cancelAdoptionRun("run-2", "", "retry-cancel");

  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { action: "start", path: "_Staging/adoption/run-2", initialize_kb: true },
      { action: "apply", run_id: "run-2", plan_id: "plan-1", retry_failed: true, only_paths: null },
      { action: "cancel", run_id: "run-2", why: null },
    ]
  );
});

test("adoption reads still carry the write-classified command's required retry key", async (context) => {
  const calls: RecordedCall[] = [];
  withAdoptionFetch(context, calls);

  await adoptionRunStatus("run-1");
  await adoptionWorkItem("run-1");

  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { action: "status", run_id: "run-1" },
      { action: "work-item", run_id: "run-1" },
    ]
  );
  for (const call of calls) {
    assert.equal(call.url, "/api/exomem/commands/adoption_studio");
    assert.match(call.headers.get("idempotency-key") ?? "", UUID_V4);
  }
  assert.notEqual(calls[0].headers.get("idempotency-key"), calls[1].headers.get("idempotency-key"));
});

test("proposal review rides the review verbs with keys only on mutations", async (context) => {
  const calls: RecordedCall[] = [];
  withAdoptionFetch(context, calls);

  await listAdoptionProposals("adoption:run-1");
  await listAdoptionProposals(null);
  await adoptionProposalContext("adoption:run-1:item-2", "fingerprint-a");
  await approveAdoptionProposal(
    { ref: "adoption:run-1:item-2", expectedFingerprint: "fingerprint-a", why: "looks right" },
    "retry-approve"
  );
  await approveAdoptionProposal(
    {
      ref: "adoption:run-1:item-3",
      expectedFingerprint: "fingerprint-b",
      why: "relation checked",
      expectedHash: "hash-1",
    },
    "retry-approve-2"
  );
  await rejectAdoptionProposal(
    { ref: "adoption:run-1:item-4", expectedFingerprint: "fingerprint-c", why: "duplicate" },
    "retry-reject"
  );

  assert.deepEqual(
    calls.map((call) => [call.url, call.body]),
    [
      [
        "/api/exomem/commands/review_memory",
        { mode: "adoption", ref: "adoption:run-1", limit: 50 },
      ],
      ["/api/exomem/commands/review_memory", { mode: "adoption", ref: null, limit: 50 }],
      [
        "/api/exomem/commands/review_item_context",
        { ref: "adoption:run-1:item-2", expected_fingerprint: "fingerprint-a" },
      ],
      [
        "/api/exomem/commands/adoption_studio",
        {
          action: "apply-proposal",
          ref: "adoption:run-1:item-2",
          expected_fingerprint: "fingerprint-a",
          why: "looks right",
          expected_hash: null,
        },
      ],
      [
        "/api/exomem/commands/adoption_studio",
        {
          action: "apply-proposal",
          ref: "adoption:run-1:item-3",
          expected_fingerprint: "fingerprint-b",
          why: "relation checked",
          expected_hash: "hash-1",
        },
      ],
      [
        "/api/exomem/commands/triage_memory",
        {
          ref: "adoption:run-1:item-4",
          action: "dismiss",
          why: "duplicate",
          expected_fingerprint: "fingerprint-c",
        },
      ],
    ]
  );
  assert.deepEqual(
    calls.map((call) => call.headers.get("idempotency-key")),
    [null, null, null, "retry-approve", "retry-approve-2", "retry-reject"]
  );
});
