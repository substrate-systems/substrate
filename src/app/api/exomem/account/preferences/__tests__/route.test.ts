import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NextRequest } from "next/server";
import { PUT } from "../route";
import { __setExomemSqlForTests } from "@/lib/exomem-hosted/db";
import { digestSecret } from "@/lib/exomem-hosted/security";

const sessionToken = Buffer.alloc(32, 1).toString("base64url");
const csrf = Buffer.alloc(32, 2).toString("base64url");
let writes = 0;

beforeEach(() => {
  writes = 0;
  __setExomemSqlForTests(async (strings) => {
    if (strings.join("").includes("exomem:find-session"))
      return {
        rows: [
          {
            id: "session",
            user_id: "user",
            tenant_id: "tenant",
            csrf_digest: digestSecret(csrf),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            theme_choice: "auto",
            email_scheme: "light",
          },
        ],
      };
    writes += 1;
    return { rows: [{ theme_choice: "dark", email_scheme: "dark" }] };
  });
});
afterEach(() => __setExomemSqlForTests(null));

function request(
  body: unknown,
  cookie = `exomem_session=${sessionToken}; exomem_csrf=${csrf}`,
  header = csrf
): NextRequest {
  return new Request("https://example.test/api/exomem/account/preferences", {
    method: "PUT",
    headers: {
      host: "example.test",
      origin: "https://example.test",
      "content-type": "application/json",
      cookie,
      "x-exomem-csrf": header,
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("account theme preference boundary", () => {
  it("returns canonical state and a cosmetic snapshot without exposing the session token or setting a stale-scope cookie", async () => {
    const response = await PUT(request({ themeChoice: "dark", emailScheme: "dark" }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.themeChoice, "dark");
    assert.equal(body.emailScheme, "dark");
    assert.equal(body.themeSnapshot.choice, "dark");
    assert.equal(JSON.stringify(body).includes(sessionToken), false);
    assert.equal(JSON.stringify(body).includes(csrf), false);
    assert.equal(JSON.stringify(body).includes(digestSecret(csrf).toString("hex")), false);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(writes, 1);
  });
  it("does not authenticate a forged theme snapshot", async () => {
    const response = await PUT(
      request(
        { themeChoice: "light", emailScheme: "light" },
        "exomem_theme_scope=forged; exomem_theme=forged"
      )
    );
    assert.equal(response.status, 401);
    assert.equal(writes, 0);
  });
  it("requires the current session's CSRF proof before writing", async () => {
    const response = await PUT(
      request({ themeChoice: "light", emailScheme: "light" }, undefined, "wrong")
    );
    assert.equal(response.status, 403);
    assert.equal(writes, 0);
  });
  for (const body of [
    { themeChoice: "sepia", emailScheme: "dark" },
    { themeChoice: "auto", emailScheme: "light", initialize: true, effectiveOnly: true },
    { themeChoice: "light", emailScheme: "light", tenantId: "another-owner" },
  ]) {
    it(`rejects an invalid or ambiguous request ${JSON.stringify(body)}`, async () => {
      assert.equal((await PUT(request(body))).status, 400);
      assert.equal(writes, 0);
    });
  }
});
