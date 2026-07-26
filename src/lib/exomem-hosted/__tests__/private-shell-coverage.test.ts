import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  isPrivateExomemPath,
  privateExomemPaths,
  shouldMountAnalytics,
  filterPostHogCapture,
  filterVercelAnalyticsEvent,
} from "../privacy";

const EXOMEM_DIR = path.join(process.cwd(), "src/app/exomem");

/**
 * Every route that renders PrivateShell is an authenticated surface, so it must
 * also be excluded from analytics. These two facts lived in separate files and
 * drifted: /exomem/adopt shipped with the Adoption Studio and was never added to
 * PRIVATE_EXOMEM_PATHS, so pageviews carrying $current_url escaped from behind
 * the auth boundary. This test derives the expectation from the routes on disk
 * so the drift cannot recur silently.
 */
function routesRenderingPrivateShell(): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(EXOMEM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(EXOMEM_DIR, entry.name);
    // A route is private if any file in its directory pulls in PrivateShell.
    const rendersShell = readdirSync(dir).some((file) => {
      const full = path.join(dir, file);
      if (!/\.(tsx|ts)$/.test(file) || !existsSync(full)) return false;
      return /PrivateShell/.test(readFileSync(full, "utf8"));
    });
    if (rendersShell) routes.push(`/exomem/${entry.name}`);
  }
  return routes.sort();
}

describe("private Exomem analytics exclusion", () => {
  test("every PrivateShell route is excluded from analytics", () => {
    const shellRoutes = routesRenderingPrivateShell();

    // Guard the guard: if this ever finds nothing, the detection broke and the
    // test would pass vacuously while covering nothing.
    assert.ok(shellRoutes.length > 0, "expected to find PrivateShell routes on disk");

    for (const route of shellRoutes) {
      assert.equal(
        isPrivateExomemPath(route),
        true,
        `${route} renders PrivateShell but is not in PRIVATE_EXOMEM_PATHS — analytics would mount on an authenticated surface`
      );
    }
  });

  test("/exomem/adopt specifically is excluded", () => {
    // Regression pin for the leak this test was written for.
    assert.equal(isPrivateExomemPath("/exomem/adopt"), true);
    assert.equal(shouldMountAnalytics("/exomem/adopt"), false);
    assert.equal(
      filterPostHogCapture({ properties: {} }, "https://substratesystems.io/exomem/adopt"),
      null
    );
    assert.equal(filterVercelAnalyticsEvent({ url: "/exomem/adopt" }), null);
  });

  test("a capture whose $current_url is a private route is dropped from a public page", () => {
    // Client-side navigation can fire a capture while location has already moved.
    assert.equal(
      filterPostHogCapture(
        { properties: { $current_url: "https://substratesystems.io/exomem/adopt" } },
        "https://substratesystems.io/exomem"
      ),
      null
    );
  });

  test("the public Exomem marketing page still reports", () => {
    // The instrumentation decision covers /exomem itself; only authenticated
    // surfaces are excluded.
    assert.equal(isPrivateExomemPath("/exomem"), false);
    assert.equal(shouldMountAnalytics("/exomem"), true);
  });

  test("listed paths cover their subpaths", () => {
    for (const prefix of privateExomemPaths) {
      assert.equal(isPrivateExomemPath(`${prefix}/anything/deeper`), true);
    }
  });
});
