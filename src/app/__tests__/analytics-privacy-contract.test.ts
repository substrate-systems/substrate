import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const providers = readFileSync(path.join(process.cwd(), "src/app/providers.tsx"), "utf8");

/**
 * Session replay records the DOM. Substrate renders recovery keys, claim tokens
 * and account identifiers, and no masking pass has been done, so replay stays
 * off until one has. Enabling it is a deliberate follow-up change that must
 * delete this test — which is the point.
 *
 * Asserted against the source text rather than by booting PostHog, because the
 * guarantee is about what is configured, and a runtime assertion would need the
 * SDK initialised in a browser to observe it.
 */
describe("PostHog privacy configuration", () => {
  it("keeps session replay disabled while masking is unverified", () => {
    assert.match(
      providers,
      /disable_session_recording:\s*true/,
      "session replay must stay disabled — surfaces rendering recovery keys and claim tokens have no masking rules yet"
    );
    assert.doesNotMatch(
      providers,
      /disable_session_recording:\s*false/,
      "session replay was enabled without a masking pass"
    );
  });

  it("routes captures through the private-route filter", () => {
    // before_send is the actual enforcement point for the Exomem privacy
    // contract; a config that drops it would silently leak authenticated pages.
    assert.match(
      providers,
      /before_send:\s*\(capture\)\s*=>\s*filterPostHogCapture\(/,
      "every capture must pass through filterPostHogCapture"
    );
  });

  it("keeps ingestion same-origin so ad blockers do not bias the data", () => {
    // Loss to blockers is silent and biased, not random: it skews hardest among
    // Windows power users, which is precisely the Endstate audience.
    assert.match(providers, /api_host:\s*["'`]\/ingest/, "ingestion must stay same-origin");
  });
});
