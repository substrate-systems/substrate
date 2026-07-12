import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXOMEM_CSRF_COOKIE,
  EXOMEM_SESSION_COOKIE,
  mintSessionMaterial,
  resolveExomemSession,
  rotateResolvedSession,
  validateMutationRequest,
} from "../sessions";
import { digestSecret } from "../security";

describe("Exomem product sessions", () => {
  it("mints separate session and CSRF material", () => {
    const material = mintSessionMaterial({
      now: new Date("2026-07-12T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x33),
    });
    assert.equal(Buffer.from(material.sessionToken, "base64url").length, 32);
    assert.equal(Buffer.from(material.csrfToken, "base64url").length, 32);
    assert.equal(material.sessionDigest.length, 32);
    assert.equal(material.csrfDigest.length, 32);
  });

  it("does not authorize an Endstate cookie as an Exomem session", async () => {
    const request = new Request("https://substratesystems.io/api/exomem/access/logout", {
      headers: { cookie: "endstate_account_session=endstate-only" },
    });
    await assert.rejects(
      () =>
        resolveExomemSession(request, {
          findSession: async () => {
            throw new Error("database should not be queried");
          },
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EXOMEM_SESSION_INVALID"
    );
  });

  it("never returns the raw Exomem cookie from session resolution", async () => {
    const sessionToken = Buffer.alloc(32, 0x52).toString("base64url");
    const request = new Request("https://substratesystems.io/exomem/home", {
      headers: { cookie: `${EXOMEM_SESSION_COOKIE}=${sessionToken}` },
    });
    const resolved = await resolveExomemSession(request, {
      findSession: async () => ({
        id: "session-1",
        userId: "user-1",
        tenantId: "tenant-1",
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-14T00:00:00.000Z",
      }),
    });
    assert.equal("sessionToken" in resolved, false);
    assert.equal(JSON.stringify(resolved).includes(sessionToken), false);
  });

  it("rotates by revoking the old row and storing only new digests", async () => {
    let stored:
      | {
          sessionId: string;
          sessionDigest: Buffer;
          csrfDigest: Buffer;
          expiresAt: Date;
        }
      | undefined;
    const material = await rotateResolvedSession(
      {
        id: "session-old",
        userId: "user-1",
        tenantId: "tenant-1",
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-13T00:00:00.000Z",
      },
      {
        now: new Date("2026-07-12T12:00:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 0x62),
        rotate: async (input) => {
          stored = input;
          return { sessionId: "session-new" };
        },
      }
    );
    assert.equal(stored?.sessionId, "session-old");
    assert.deepEqual(stored?.sessionDigest, digestSecret(material.sessionToken));
    assert.deepEqual(stored?.csrfDigest, digestSecret(material.csrfToken));
    assert.equal(JSON.stringify(stored).includes(material.sessionToken), false);
    assert.equal(JSON.stringify(stored).includes(material.csrfToken), false);
  });

  it("requires same Origin/Host and matching cookie/header/session CSRF", () => {
    const csrfToken = Buffer.alloc(32, 0x41).toString("base64url");
    const request = new Request("https://substratesystems.io/api/exomem/access/logout", {
      method: "POST",
      headers: {
        host: "substratesystems.io",
        origin: "https://substratesystems.io",
        cookie: `${EXOMEM_SESSION_COOKIE}=session; ${EXOMEM_CSRF_COOKIE}=${csrfToken}`,
        "x-exomem-csrf": csrfToken,
      },
    });
    assert.doesNotThrow(() =>
      validateMutationRequest(request, {
        csrfDigest: digestSecret(csrfToken),
      })
    );

    const crossSite = new Request(request.url, {
      method: "POST",
      headers: {
        host: "substratesystems.io",
        origin: "https://attacker.example",
        cookie: `${EXOMEM_CSRF_COOKIE}=${csrfToken}`,
        "x-exomem-csrf": csrfToken,
      },
    });
    assert.throws(
      () =>
        validateMutationRequest(crossSite, {
          csrfDigest: Buffer.alloc(32),
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CSRF_REJECTED"
    );
  });
});
