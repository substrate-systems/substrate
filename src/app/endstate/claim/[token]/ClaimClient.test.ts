import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openClaimInEndstate } from "./ClaimClient";

const TOKEN = "claim token/with?reserved&characters";
const EXPECTED_URL = "endstate://claim?token=claim%20token%2Fwith%3Freserved%26characters";

describe("openClaimInEndstate", () => {
  it("copies the raw token before launching the encoded deep link", async () => {
    const events: string[] = [];

    await openClaimInEndstate(
      TOKEN,
      async (value) => {
        events.push(`copy:${value}`);
      },
      (url) => {
        events.push(`launch:${url}`);
      }
    );

    assert.deepEqual(events, [`copy:${TOKEN}`, `launch:${EXPECTED_URL}`]);
  });

  it("launches before a pending clipboard write settles", async () => {
    const events: string[] = [];
    let settleCopy!: () => void;
    const pendingCopy = new Promise<void>((resolve) => {
      settleCopy = resolve;
    });

    openClaimInEndstate(
      TOKEN,
      (value) => {
        events.push(`copy:${value}`);
        return pendingCopy;
      },
      (url) => {
        events.push(`launch:${url}`);
      }
    );

    assert.deepEqual(events, [`copy:${TOKEN}`, `launch:${EXPECTED_URL}`]);
    settleCopy();
    await pendingCopy;
  });

  it("still launches when clipboard access fails", async () => {
    const launched: string[] = [];

    openClaimInEndstate(
      TOKEN,
      async () => {
        throw new Error("clipboard denied");
      },
      (url) => {
        launched.push(url);
      }
    );

    await Promise.resolve();

    assert.deepEqual(launched, [EXPECTED_URL]);
  });

  /**
   * The local product carries no telemetry as a published, inviolable
   * commitment. The deep link is the one seam where a web-side identifier could
   * quietly cross into it, so the contract is pinned here rather than left to
   * review: the link carries the claim token and nothing else, forever.
   */
  it("carries the claim token and nothing else across the desktop boundary", () => {
    let launched = "";
    openClaimInEndstate(
      TOKEN,
      async () => {},
      (url) => {
        launched = url;
      }
    );

    const url = new URL(launched);
    assert.equal(url.protocol, "endstate:");

    const params = [...url.searchParams.keys()];
    assert.deepEqual(
      params,
      ["token"],
      `deep link must carry only "token", found: ${params.join(", ")}`
    );
    assert.equal(url.searchParams.get("token"), TOKEN);
  });

  it("carries no analytics, session, device or campaign identifier", () => {
    let launched = "";
    openClaimInEndstate(
      TOKEN,
      async () => {},
      (url) => {
        launched = url;
      }
    );

    // Named explicitly so a future addition has to delete an assertion rather
    // than slip past a generic shape check.
    const forbidden = [
      "distinct_id",
      "ph_distinct_id",
      "posthog",
      "session",
      "session_id",
      "device",
      "device_id",
      "machine",
      "anonymous_id",
      "user_id",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "gclid",
      "fbclid",
      "ref",
    ];
    const lowered = launched.toLowerCase();
    for (const key of forbidden) {
      assert.equal(
        lowered.includes(key),
        false,
        `deep link must not carry "${key}" — the desktop app receives no identifiers`
      );
    }
  });
});
