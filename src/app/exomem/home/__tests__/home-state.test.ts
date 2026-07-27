import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSingleFlight,
  nextStatusPollDelayMs,
  parseInstallActions,
  parseLifecycleResponse,
} from "../home-state";

describe("hosted Home lifecycle state", () => {
  it("keeps the content-free support reference from status responses", () => {
    assert.deepEqual(
      parseLifecycleResponse({
        status: {
          state: "preparing",
          code: "CELL_PREPARING",
          retryable: true,
          requestId: "018f2d91-7c42-7000-8000-000000000082",
        },
      }),
      {
        state: "preparing",
        code: "CELL_PREPARING",
        retryable: true,
        requestId: "018f2d91-7c42-7000-8000-000000000082",
      }
    );
  });

  it("rejects malformed or unknown lifecycle states", () => {
    assert.equal(parseLifecycleResponse({}), null);
    assert.equal(parseLifecycleResponse({ status: { state: "invented" } }), null);
    assert.equal(parseLifecycleResponse({ status: [] }), null);
  });

  it("accepts only tenant-neutral HTTPS install actions", () => {
    assert.deepEqual(
      parseInstallActions({
        installActions: [
          {
            platform: "claude",
            version: "0.34.0",
            installUrl: "https://claude.ai/plugins/exomem-hosted",
          },
          {
            platform: "openai",
            version: "0.34.0",
            installUrl: "https://chatgpt.com/plugins/exomem-hosted?tenant=private",
          },
        ],
      }),
      [
        {
          platform: "claude",
          version: "0.34.0",
          installUrl: "https://claude.ai/plugins/exomem-hosted",
        },
      ]
    );
  });

  it("backs off status polling to a finite ceiling and stops once ready", () => {
    const preparing = {
      state: "preparing" as const,
      code: "CELL_PREPARING",
      retryable: true,
    };
    assert.deepEqual(
      [0, 1, 2, 3, 4, 20].map((attempt) => nextStatusPollDelayMs(preparing, attempt)),
      [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]
    );
    assert.equal(
      nextStatusPollDelayMs({ state: "ready", code: "CELL_READY", retryable: false }, 0),
      null
    );
    assert.equal(
      nextStatusPollDelayMs({ state: "deleted", code: "EXOMEM_DELETED", retryable: false }, 0),
      null
    );
  });

  it("coalesces manual and scheduled refreshes so stale status cannot win", async () => {
    const singleFlight = createSingleFlight<string>();
    let resolve!: (value: string) => void;
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise<string>((done) => {
        resolve = done;
      });
    };

    const scheduled = singleFlight(load);
    const manual = singleFlight(load);
    assert.equal(calls, 1);
    assert.equal(scheduled, manual);
    resolve("ready");
    assert.equal(await manual, "ready");

    const next = singleFlight(async () => {
      calls += 1;
      return "ready-again";
    });
    assert.equal(await next, "ready-again");
    assert.equal(calls, 2);
  });
});
