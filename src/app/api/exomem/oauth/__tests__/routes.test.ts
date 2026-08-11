import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { pkceS256 } from "@/lib/exomem-hosted/oauth";
import { readOAuthForm } from "@/lib/exomem-hosted/oauth-http";
import { digestSecret } from "@/lib/exomem-hosted/security";

const BASE_URL = "https://hosted.example.test";
const RESOURCE = `${BASE_URL}/api/exomem/mcp/v1`;
const CLIENT_ID = "https://client.example.test/client.json";
const REDIRECT_URI = "https://client.example.test/oauth/callback";
const VERIFIER = "v".repeat(43);
const SESSION_TOKEN = Buffer.alloc(32, 0x31).toString("base64url");
const FORM_SECRET = "oauth-route-content-sentinel";

type StoredContinuation = {
  transactionDigest: Buffer;
  stateDigest: Buffer;
  stateEnvelope: Record<string, unknown>;
  formNonceDigest: Buffer;
  continuationBinding: Buffer;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  pkceChallenge: string;
  expiresAt: Date;
};

const continuations = new Map<string, StoredContinuation>();
const attached: Array<{ sessionId: string; transactionDigest: Buffer; codeDigest: Buffer }> = [];
let admitCalls: Array<Record<string, unknown>> = [];
let admissionError: Error | null = null;
let rateLimitAllowed = true;
let oauthClientResolutions = 0;
let oauthClientResolutionError: Error | null = null;
let tokenStoreCalls = 0;
const codes = new Map<
  string,
  {
    clientId: string;
    redirectUri: string;
    resource: string;
    pkceChallenge: string;
    consumed: boolean;
  }
>();
const refreshCredentials = new Map<
  string,
  {
    familyId: string;
    clientId: string;
    resource: string;
    scopes: string[];
    consumed: boolean;
    policy: boolean;
  }
>();
const families = new Map<string, { clientId: string; revoked: boolean; revokedReason?: string }>();
const revocableCredentialFamilies = new Map<string, string>();

function digestKey(value: Buffer): string {
  return value.toString("base64url");
}

function tokenKey(value: string): string {
  return digestKey(digestSecret(value));
}

function seedCode(code: string): void {
  codes.set(tokenKey(code), {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    pkceChallenge: pkceS256(VERIFIER),
    consumed: false,
  });
}

function seedRefreshToken(token: string, input: { familyId: string; policy: boolean }): void {
  families.set(input.familyId, { clientId: CLIENT_ID, revoked: false });
  refreshCredentials.set(tokenKey(token), {
    familyId: input.familyId,
    clientId: CLIENT_ID,
    resource: RESOURCE,
    scopes: ["exomem.read"],
    consumed: false,
    policy: input.policy,
  });
  revocableCredentialFamilies.set(tokenKey(token), input.familyId);
}

function storedContinuation(input: StoredContinuation) {
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scopes: input.scopes,
    stateEnvelope: input.stateEnvelope,
    stateDigest: input.stateDigest,
    formNonceDigest: input.formNonceDigest,
    continuationBinding: input.continuationBinding,
    pkceChallenge: input.pkceChallenge,
  };
}

before(() => {
  process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 0x51).toString("base64url");
  process.env.EXOMEM_PUBLIC_BASE_URL = BASE_URL;
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      resolveApprovedOAuthClient: async (clientId: string) => {
        oauthClientResolutions += 1;
        if (oauthClientResolutionError) throw oauthClientResolutionError;
        return clientId === CLIENT_ID
          ? {
              id: "018f2d91-7c42-7000-8000-000000000041",
              clientId: CLIENT_ID,
              redirectUris: [REDIRECT_URI],
              admissionMode: "pinned",
            }
          : null;
      },
      createAuthorizationTransaction: async (input: StoredContinuation) => {
        continuations.set(digestKey(input.transactionDigest), input);
        return { id: `transaction-${continuations.size}` };
      },
      findPendingOAuthAuthorization: async (transactionDigest: Buffer) => {
        const transaction = continuations.get(digestKey(transactionDigest));
        return transaction ? storedContinuation(transaction) : null;
      },
      attachExistingOwnerAuthorizationAtomic: async (input: {
        sessionId: string;
        transactionDigest: Buffer;
        codeDigest: Buffer;
      }) => {
        attached.push(input);
        return { grantId: "grant-1", tenantId: "tenant-1" };
      },
      issueOAuthTokensFromCodeAtomic: async (input: {
        codeDigest: Buffer;
        clientId: string;
        redirectUri: string;
        resource: string;
        pkceChallenge: string;
        refreshDigest: Buffer;
        accessDigest: Buffer;
      }) => {
        tokenStoreCalls++;
        const code = codes.get(digestKey(input.codeDigest));
        if (
          !code ||
          code.consumed ||
          code.clientId !== input.clientId ||
          code.redirectUri !== input.redirectUri ||
          code.resource !== input.resource ||
          code.pkceChallenge !== input.pkceChallenge
        ) {
          return null;
        }
        code.consumed = true;
        const familyId = `family-${codes.size}`;
        families.set(familyId, { clientId: code.clientId, revoked: false });
        refreshCredentials.set(digestKey(input.refreshDigest), {
          familyId,
          clientId: code.clientId,
          resource: code.resource,
          scopes: ["exomem.read"],
          consumed: false,
          policy: true,
        });
        revocableCredentialFamilies.set(digestKey(input.refreshDigest), familyId);
        revocableCredentialFamilies.set(digestKey(input.accessDigest), familyId);
        return {
          grantId: "grant-1",
          familyId,
          clientId: code.clientId,
          resource: code.resource,
          scopes: ["exomem.read"],
          refreshInserted: true,
        };
      },
      rotateOAuthRefreshTokenAtomic: async (input: {
        refreshDigest: Buffer;
        replacementRefreshDigest: Buffer;
        accessDigest: Buffer;
        clientId: string;
        resource: string;
      }) => {
        tokenStoreCalls++;
        const credential = refreshCredentials.get(digestKey(input.refreshDigest));
        const family = credential ? families.get(credential.familyId) : null;
        if (
          !credential ||
          !family ||
          family.revoked ||
          credential.clientId !== input.clientId ||
          credential.resource !== input.resource
        ) {
          return null;
        }
        if (credential.consumed) {
          family.revoked = true;
          family.revokedReason = "refresh_replayed";
          return null;
        }
        if (!credential.policy) return null;
        credential.consumed = true;
        refreshCredentials.set(digestKey(input.replacementRefreshDigest), {
          ...credential,
          consumed: false,
        });
        revocableCredentialFamilies.set(
          digestKey(input.replacementRefreshDigest),
          credential.familyId
        );
        revocableCredentialFamilies.set(digestKey(input.accessDigest), credential.familyId);
        return {
          grantId: "grant-1",
          familyId: credential.familyId,
          clientId: credential.clientId,
          resource: credential.resource,
          scopes: credential.scopes,
        };
      },
      revokeOAuthTokenForClient: async (input: { tokenDigest: Buffer; clientId: string }) => {
        tokenStoreCalls++;
        const familyId = revocableCredentialFamilies.get(digestKey(input.tokenDigest));
        const family = familyId ? families.get(familyId) : null;
        if (family && family.clientId === input.clientId) {
          family.revoked = true;
          family.revokedReason = "client_revoked";
        }
      },
      admitFirstOAuthInviteAtomic: async (input: Record<string, unknown>) => {
        admitCalls.push(input);
        if (admissionError) throw admissionError;
        return { tenantId: "tenant-1", sessionId: "session-1", grantId: "grant-1" };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        oauthAuthorizeIp: {},
        oauthAuthorizeClient: {},
        oauthTokenIp: { windowSeconds: 60 },
        oauthRevokeIp: { windowSeconds: 60 },
      },
      clientAddressKey: () => "203.0.113.10",
      takeExomemRateLimit: async () => rateLimitAllowed,
    },
  });
  mock.module("@/lib/exomem-hosted/public-origin", {
    namedExports: { exomemPublicBaseUrlFromEnv: () => BASE_URL },
  });
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({ id: "session-1" }),
      validatePublicAccessRequest: () => undefined,
      magicLinkChallengeFromRequest: () => "challenge",
      mintSessionMaterial: () => ({
        sessionToken: SESSION_TOKEN,
        sessionDigest: digestSecret(SESSION_TOKEN),
        csrfToken: Buffer.alloc(32, 0x32).toString("base64url"),
        csrfDigest: Buffer.alloc(32, 0x33),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      applySessionCookies: (response: import("next/server").NextResponse) => {
        response.cookies.set("exomem_session", SESSION_TOKEN, { httpOnly: true, path: "/" });
      },
      clearMagicLinkChallengeCookie: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/access", {
    namedExports: {
      redeemInvite: async () => {
        throw new Error("the OAuth continuation path must use atomic admission");
      },
      redeemMagicLink: async () => ({
        sessionToken: SESSION_TOKEN,
        csrfToken: Buffer.alloc(32, 0x32).toString("base64url"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  continuations.clear();
  attached.length = 0;
  admitCalls = [];
  admissionError = null;
  rateLimitAllowed = true;
  oauthClientResolutions = 0;
  oauthClientResolutionError = null;
  tokenStoreCalls = 0;
  codes.clear();
  refreshCredentials.clear();
  families.clear();
  revocableCredentialFamilies.clear();
});

function authorizeRequest(state = "client-state", overrides: Record<string, string> = {}): Request {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: "exomem.read offline_access",
    state,
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
    ...overrides,
  });
  return new Request(`${BASE_URL}/api/exomem/oauth/authorize?${query}`, {
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
}

function cookie(response: Response, name: string): string {
  const match = response.headers
    .getSetCookie()
    .map((value) => value.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`)))
    .find((value): value is RegExpMatchArray => !!value);
  assert.ok(match, `missing ${name} cookie`);
  return match[1];
}

function completionRequest(input: {
  transaction: string;
  nonce: string;
  confirmation: string;
}): Request {
  return new Request(`${BASE_URL}/api/exomem/oauth/authorize/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      host: "hosted.example.test",
      cookie: [
        `exomem_oauth_tx=${input.transaction}`,
        `exomem_oauth_form_nonce=${input.nonce}`,
        `exomem_session=${SESSION_TOKEN}`,
      ].join("; "),
    },
    body: new URLSearchParams({ nonce: input.nonce, confirmation: input.confirmation }),
  });
}

function confirmation(response: Response): string {
  const location = response.headers.get("location");
  assert.ok(location);
  const value = new URL(location).searchParams.get("confirmation");
  assert.ok(value);
  return value;
}

describe("Exomem OAuth routes", () => {
  it("rate limits before resolving a client or opening an authorization continuation", async () => {
    const { GET } = await import("../authorize/route");
    rateLimitAllowed = false;

    const response = await GET(authorizeRequest());

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "temporarily_unavailable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "600");
    assert.equal(oauthClientResolutions, 0);
    assert.equal(continuations.size, 0);
  });

  it("returns a safe local outage response and log when client resolution throws", async () => {
    const { GET } = await import("../authorize/route");
    const sentinel = "authorize-runtime-sentinel";
    const logged: unknown[][] = [];
    const originalError = console.error;
    const resolverError = Object.assign(new Error(sentinel), {
      code: "XX000",
      arbitrary: sentinel,
    });
    resolverError.stack = sentinel;
    oauthClientResolutionError = resolverError;
    console.error = (...args: unknown[]) => logged.push(args);

    try {
      const response = await GET(authorizeRequest());

      assert.equal(response.status, 503);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(await response.json(), { error: "temporarily_unavailable" });
      assert.deepEqual(logged, [
        [
          {
            event: "exomem_oauth_authorize_operational_failure",
            stage: "client_resolution",
            error_class: "error",
            error_code: "XX000",
          },
        ],
      ]);
      assert.equal(JSON.stringify(logged).includes(sentinel), false);
    } finally {
      console.error = originalError;
    }
  });

  it("keeps invalid clients and redirects local without an operational-failure log", async () => {
    const { GET } = await import("../authorize/route");
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args);

    try {
      const invalidClient = await GET(authorizeRequest("client-state", { client_id: "unknown" }));
      const invalidRedirect = await GET(
        authorizeRequest("client-state", {
          redirect_uri: "https://attacker.example.test/oauth/callback",
        })
      );

      assert.equal(invalidClient.status, 400);
      assert.deepEqual(await invalidClient.json(), { error: "invalid_request" });
      assert.equal(invalidRedirect.status, 400);
      assert.deepEqual(await invalidRedirect.json(), { error: "invalid_request" });
      assert.deepEqual(logged, []);
    } finally {
      console.error = originalError;
    }
  });

  it("returns approved authorization failures to the bound client with the original state", async () => {
    const { GET } = await import("../authorize/route");
    const response = await GET(
      authorizeRequest("opaque client state", { scope: "exomem.read unsupported.scope" })
    );

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const callback = new URL(response.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, REDIRECT_URI);
    assert.equal(callback.searchParams.get("error"), "invalid_request");
    assert.equal(callback.searchParams.get("state"), "opaque client state");
  });

  it("keeps an unapproved redirect authorization failure local", async () => {
    const { GET } = await import("../authorize/route");
    const response = await GET(
      authorizeRequest("attacker state", {
        redirect_uri: "https://attacker.example.test/oauth/callback",
        scope: "exomem.read unsupported.scope",
      })
    );

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  });

  it("omits an oversized state from an approved authorization error callback", async () => {
    const { GET } = await import("../authorize/route");
    const response = await GET(
      authorizeRequest("s".repeat(2049), { scope: "exomem.read unsupported.scope" })
    );

    assert.equal(response.status, 303);
    const location = response.headers.get("location");
    assert.ok(location);
    assert.ok(location.length < 300);
    const callback = new URL(location);
    assert.equal(callback.searchParams.get("error"), "invalid_request");
    assert.equal(callback.searchParams.has("state"), false);
  });

  it("redirects a valid authorization into an opaque, sealed continuation", async () => {
    const { GET } = await import("../authorize/route");
    const response = await GET(authorizeRequest());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const transaction = cookie(response, "exomem_oauth_tx");
    const nonce = cookie(response, "exomem_oauth_form_nonce");
    const handle = confirmation(response);
    assert.notEqual(handle, transaction);
    assert.equal(response.headers.get("location")?.includes(transaction), false);
    assert.equal(response.headers.getSetCookie().join("\n").includes("HttpOnly"), true);
    assert.equal(response.headers.getSetCookie().join("\n").includes("Secure"), true);
    const continuityCookies = response.headers
      .getSetCookie()
      .filter((value) => value.startsWith("exomem_oauth_"));
    assert.equal(continuityCookies.length, 2);
    assert.equal(continuityCookies.every((value) => /Path=\//i.test(value)), true);
    const stored = continuations.get(digestKey(digestSecret(transaction)));
    assert.ok(stored);
    assert.deepEqual(
      {
        clientId: stored.clientId,
        redirectUri: stored.redirectUri,
        resource: stored.resource,
        scopes: stored.scopes,
        pkceChallenge: stored.pkceChallenge,
      },
      {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        scopes: ["exomem.read", "offline_access"],
        pkceChallenge: pkceS256(VERIFIER),
      }
    );
    assert.notEqual(nonce, transaction);
  });

  it("keeps concurrent first continuations distinct and rejects a stale confirmation", async () => {
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/complete/route");
    const [first, second] = await Promise.all([
      GET(authorizeRequest("one")),
      GET(authorizeRequest("two")),
    ]);
    const firstTransaction = cookie(first, "exomem_oauth_tx");
    const secondTransaction = cookie(second, "exomem_oauth_tx");
    assert.notEqual(firstTransaction, secondTransaction);
    assert.notEqual(confirmation(first), confirmation(second));
    const stale = await POST(
      completionRequest({
        transaction: secondTransaction,
        nonce: cookie(second, "exomem_oauth_form_nonce"),
        confirmation: confirmation(first),
      })
    );
    assert.equal(stale.status, 400);
    assert.equal(attached.length, 0);
  });

  it("completes only the bound client redirect and state without exposing the continuation", async () => {
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/complete/route");
    const started = await GET(authorizeRequest("bound-state"));
    const transaction = cookie(started, "exomem_oauth_tx");
    const complete = await POST(
      completionRequest({
        transaction,
        nonce: cookie(started, "exomem_oauth_form_nonce"),
        confirmation: confirmation(started),
      })
    );
    assert.equal(complete.status, 303);
    const redirect = new URL(complete.headers.get("location")!);
    assert.equal(redirect.origin + redirect.pathname, REDIRECT_URI);
    assert.equal(redirect.searchParams.get("state"), "bound-state");
    assert.ok(redirect.searchParams.get("code"));
    assert.equal(complete.headers.get("location")?.includes(transaction), false);
    assert.equal(attached.length, 1);
    assert.equal(attached[0].sessionId, "session-1");
    assert.deepEqual(attached[0].transactionDigest, digestSecret(transaction));
  });

  it("continues an authenticated browser and a magic-link browser through the same transaction", async () => {
    const { GET } = await import("../authorize/route");
    const { POST: complete } = await import("../authorize/complete/route");
    const { POST: magic } = await import("../../access/magic-link/redeem/route");
    const started = await GET(authorizeRequest());
    const transaction = cookie(started, "exomem_oauth_tx");
    const nonce = cookie(started, "exomem_oauth_form_nonce");
    const existing = await complete(
      completionRequest({ transaction, nonce, confirmation: confirmation(started) })
    );
    assert.equal(existing.status, 303);
    const magicStarted = await GET(authorizeRequest("magic-state"));
    const magicTransaction = cookie(magicStarted, "exomem_oauth_tx");
    const magicResult = await magic(
      new Request(`${BASE_URL}/api/exomem/access/magic-link/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          host: "hosted.example.test",
          cookie: `exomem_oauth_tx=${magicTransaction}`,
        },
        body: JSON.stringify({ token: Buffer.alloc(32, 0x42).toString("base64url") }),
      }) as never
    );
    const magicDestination = ((await magicResult.json()) as { destination: string }).destination;
    const magicConfirmation = new URL(magicDestination, BASE_URL).searchParams.get("confirmation");
    assert.equal(new URL(magicDestination, BASE_URL).pathname, "/exomem/authorize");
    assert.ok(magicConfirmation);
    assert.equal(magicDestination.includes(magicTransaction), false);
    const magicComplete = await complete(
      completionRequest({
        transaction: magicTransaction,
        nonce: cookie(magicStarted, "exomem_oauth_form_nonce"),
        confirmation: magicConfirmation,
      })
    );
    assert.equal(magicComplete.status, 303);
    assert.equal(
      new URL(magicComplete.headers.get("location")!).searchParams.get("state"),
      "magic-state"
    );
  });

  it("redeems a first invite through the access route into the bound continuation", async () => {
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../../access/redeem/route");
    const inviteToken = Buffer.alloc(32, 0x41).toString("base64url");
    const started = await GET(authorizeRequest("invite-state"));
    const transaction = cookie(started, "exomem_oauth_tx");
    const nonce = cookie(started, "exomem_oauth_form_nonce");
    const redeemed = await POST(
      new Request(`${BASE_URL}/api/exomem/access/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          host: "hosted.example.test",
          cookie: `exomem_oauth_tx=${transaction}; exomem_oauth_form_nonce=${nonce}`,
        },
        body: JSON.stringify({ token: inviteToken }),
      }) as never
    );
    assert.equal(redeemed.status, 200);
    const body = (await redeemed.json()) as { destination: string };
    const destination = new URL(body.destination);
    assert.equal(destination.origin + destination.pathname, REDIRECT_URI);
    assert.equal(destination.searchParams.get("state"), "invite-state");
    assert.ok(destination.searchParams.get("code"));
    assert.equal(JSON.stringify(body).includes(inviteToken), false);
    assert.match(redeemed.headers.getSetCookie().join("\n"), /exomem_session=.*HttpOnly/i);
    const clearedContinuityCookies = redeemed.headers
      .getSetCookie()
      .filter((value) => value.startsWith("exomem_oauth_"));
    assert.equal(clearedContinuityCookies.length, 2);
    assert.equal(
      clearedContinuityCookies.every(
        (value) => /Path=\//i.test(value) && /Max-Age=0/i.test(value)
      ),
      true
    );
    assert.equal(admitCalls.length, 1);
    assert.deepEqual(admitCalls[0].transactionDigest, digestSecret(transaction));
    assert.deepEqual(admitCalls[0].inviteDigest, digestSecret(inviteToken));
    assert.ok(Buffer.isBuffer(admitCalls[0].sessionDigest));
    assert.ok(Buffer.isBuffer(admitCalls[0].codeDigest));
  });

  it("returns an opaque temporary-unavailable OAuth response when first-admission capacity is exhausted", async () => {
    admissionError = new (await import("@/lib/exomem-hosted/errors")).ExomemHostedError({
      code: "CAPACITY_UNAVAILABLE",
      status: 503,
      message: "hosted capacity is temporarily unavailable",
      retryable: true,
    });
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/invite/route");
    const started = await GET(authorizeRequest("capacity-state"));
    const transaction = cookie(started, "exomem_oauth_tx");
    const nonce = cookie(started, "exomem_oauth_form_nonce");
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/authorize/invite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: `exomem_oauth_tx=${transaction}`,
        },
        body: JSON.stringify({ token: Buffer.alloc(32, 0x45).toString("base64url"), nonce }),
      })
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string; request_id?: string };
    assert.equal(body.error, "temporarily_unavailable");
    assert.match(body.request_id ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "1");
  });

  it("returns a safe retryable capacity envelope from the UI-facing access redeem path", async () => {
    admissionError = new (await import("@/lib/exomem-hosted/errors")).ExomemHostedError({
      code: "CAPACITY_UNAVAILABLE",
      status: 503,
      message: "hosted capacity is temporarily unavailable",
      retryable: true,
      retryAfterMs: 1000,
      remediation: "retry_later",
    });
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../../access/redeem/route");
    const started = await GET(authorizeRequest("capacity-ui-state"));
    const transaction = cookie(started, "exomem_oauth_tx");
    const nonce = cookie(started, "exomem_oauth_form_nonce");
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/access/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          host: "hosted.example.test",
          cookie: `exomem_oauth_tx=${transaction}; exomem_oauth_form_nonce=${nonce}`,
        },
        body: JSON.stringify({ token: Buffer.alloc(32, 0x46).toString("base64url") }),
      }) as never
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as {
      error: {
        code: string;
        requestId?: string;
        retryable: boolean;
        message: string;
        retryAfterMs?: number;
        remediation?: string;
      };
    };
    assert.equal(body.error.code, "CAPACITY_UNAVAILABLE");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.retryAfterMs, 1000);
    assert.equal(body.error.remediation, "retry_later");
    assert.match(body.error.requestId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(body).includes("capacity-ui-state"), false);
    assert.equal(JSON.stringify(body).includes("tenant"), false);
  });

  it("exchanges one authorization code with exact PKCE and resource binding", async () => {
    const { POST } = await import("../token/route");
    const code = Buffer.alloc(32, 0x61).toString("base64url");
    seedCode(code);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    });
    const wrongVerifier = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(body), code_verifier: "w".repeat(43) }),
      })
    );
    assert.equal(wrongVerifier.status, 400);
    assert.equal(codes.get(tokenKey(code))?.consumed, false);
    const wrongResource = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(body), resource: `${RESOURCE}/other` }),
      })
    );
    assert.equal(wrongResource.status, 400);
    assert.equal(codes.get(tokenKey(code))?.consumed, false);
    const first = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(first.status, 200);
    assert.equal((await first.text()).includes(code), false);
    assert.equal(codes.get(tokenKey(code))?.consumed, true);
    const replay = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: "invalid_grant" });
  });

  it("rotates a refresh token, revokes its family on replay, and leaves policy denial unconsumed", async () => {
    const { POST } = await import("../token/route");
    const refreshToken = Buffer.alloc(32, 0x71).toString("base64url");
    const policyDeniedToken = Buffer.alloc(32, 0x72).toString("base64url");
    seedRefreshToken(refreshToken, { familyId: "rotation-family", policy: true });
    seedRefreshToken(policyDeniedToken, { familyId: "policy-family", policy: false });
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      resource: RESOURCE,
    });
    const wrongClient = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(body), client_id: "other-client" }),
      })
    );
    assert.equal(wrongClient.status, 400);
    assert.equal(refreshCredentials.get(tokenKey(refreshToken))?.consumed, false);
    const success = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(success.status, 200);
    assert.equal(refreshCredentials.get(tokenKey(refreshToken))?.consumed, true);
    const replay = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: "invalid_grant" });
    assert.deepEqual(families.get("rotation-family"), {
      clientId: CLIENT_ID,
      revoked: true,
      revokedReason: "refresh_replayed",
    });
    const policyDenied = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: policyDeniedToken,
          client_id: CLIENT_ID,
          resource: RESOURCE,
        }),
      })
    );
    assert.equal(policyDenied.status, 400);
    assert.deepEqual(await policyDenied.json(), { error: "invalid_grant" });
    assert.equal(refreshCredentials.get(tokenKey(policyDeniedToken))?.consumed, false);
    assert.equal(families.get("policy-family")?.revoked, false);
  });

  it("returns RFC 7009 success for unknown revocation while invoking real-family revocation", async () => {
    const { POST } = await import("../revoke/route");
    const knownToken = Buffer.alloc(32, 0x81).toString("base64url");
    seedRefreshToken(knownToken, { familyId: "revocable-family", policy: true });
    const wrongClient = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "other-client", token: knownToken }),
      })
    );
    assert.equal(wrongClient.status, 200);
    assert.equal(families.get("revocable-family")?.revoked, false);
    for (const token of ["unknown", knownToken]) {
      const response = await POST(
        new Request(`${BASE_URL}/api/exomem/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: CLIENT_ID, token }),
        })
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(families.get("revocable-family"), {
      clientId: CLIENT_ID,
      revoked: true,
      revokedReason: "client_revoked",
    });
  });

  it("rate limits revocation before reading form data or invoking the token store", async () => {
    const { POST } = await import("../revoke/route");
    rateLimitAllowed = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(`client_id=${FORM_SECRET}&token=${FORM_SECRET}`)
        );
        controller.close();
      },
    });
    const request = new Request(`${BASE_URL}/api/exomem/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await POST(request);
    const responseBody = await response.text();
    assert.equal(response.status, 429);
    assert.deepEqual(JSON.parse(responseBody), { error: "temporarily_unavailable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(request.bodyUsed, false);
    assert.equal(tokenStoreCalls, 0);
    assert.equal(responseBody.includes(FORM_SECRET), false);
  });

  it("rejects oversized and non-form token requests without reflecting credentials", async () => {
    const { POST } = await import("../token/route");
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: FORM_SECRET }),
      })
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.text()).includes(FORM_SECRET), false);
  });

  it("rate limits token requests before reading form data or invoking the token store", async () => {
    const { POST } = await import("../token/route");
    rateLimitAllowed = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`code=${FORM_SECRET}`));
        controller.close();
      },
    });
    const request = new Request(`${BASE_URL}/api/exomem/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await POST(request);
    const responseBody = await response.text();
    assert.equal(response.status, 429);
    assert.deepEqual(JSON.parse(responseBody), { error: "temporarily_unavailable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(request.bodyUsed, false);
    assert.equal(tokenStoreCalls, 0);
    assert.equal(responseBody.includes(FORM_SECRET), false);
  });

  it("rejects unexpected and duplicate token form fields before token handling", async () => {
    await assert.rejects(
      () =>
        readOAuthForm(
          new Request(`${BASE_URL}/api/exomem/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=refresh_token&client_id=client&refresh_token=one&scope=exomem.read",
          }),
          ["grant_type", "client_id", "refresh_token", "resource"]
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
    );
    await assert.rejects(
      () =>
        readOAuthForm(
          new Request(`${BASE_URL}/api/exomem/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=refresh_token&client_id=client&client_id=duplicate&refresh_token=one",
          }),
          ["grant_type", "client_id", "refresh_token", "resource"]
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
    );
  });
});
