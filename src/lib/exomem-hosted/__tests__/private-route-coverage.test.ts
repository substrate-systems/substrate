import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  isPrivateExomemPath,
  privateExomemPaths,
  shouldMountAnalytics,
  filterPostHogCapture,
  filterVercelAnalyticsEvent,
} from "../privacy";

const EXOMEM_DIR = path.join(process.cwd(), "src/app/exomem");

/** True when the page exports `metadata` with `referrer: "no-referrer"`, read from its syntax tree. */
function declaresNoReferrer(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  );
  return source.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "metadata" &&
          declaration.initializer !== undefined &&
          ts.isObjectLiteralExpression(declaration.initializer) &&
          declaration.initializer.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "referrer" &&
              ts.isStringLiteral(property.initializer) &&
              property.initializer.text === "no-referrer"
          )
      )
  );
}

/**
 * Every route whose page sends no referrer is an authenticated or token-bearing
 * surface, so it must also be excluded from analytics. These two facts lived in
 * separate files and drifted: /exomem/adopt shipped with the Adoption Studio and
 * was never added to PRIVATE_EXOMEM_PATHS, so pageviews carrying $current_url
 * escaped from behind the auth boundary. This test derives the expectation from
 * the routes on disk so the drift cannot recur silently.
 */
function routesDeclaringNoReferrer(): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(EXOMEM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const page = path.join(EXOMEM_DIR, entry.name, "page.tsx");
    if (existsSync(page) && declaresNoReferrer(page)) routes.push(`/exomem/${entry.name}`);
  }
  return routes.sort();
}

describe("private Exomem analytics exclusion", () => {
  test("every no-referrer route is excluded from analytics", () => {
    const privateRoutes = routesDeclaringNoReferrer();

    // Guard the guard: if this ever finds nothing, the detection broke and the
    // test would pass vacuously while covering nothing.
    assert.ok(privateRoutes.length > 0, "expected to find no-referrer routes on disk");

    for (const route of privateRoutes) {
      assert.equal(
        isPrivateExomemPath(route),
        true,
        `${route} sends no referrer but is not in PRIVATE_EXOMEM_PATHS — analytics would mount on an authenticated surface`
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
