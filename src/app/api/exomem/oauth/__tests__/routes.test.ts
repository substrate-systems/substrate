import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
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

// Task 3.5 / item 4 (OAuth resource binding): a Cloud-only client and
// resource, resolved only through cloud-oauth.ts's resolveApprovedCloudOAuthClient
// -- never through the hosted resolveApprovedOAuthClient mock above, which
// returns null for anything but CLIENT_ID. If a route under test still called
// the hosted resolver despite the flag being on, these tests would fail at
// client resolution rather than at the resource assertion.
const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const CLOUD_CLIENT_ID = "https://cloud-client.example.test/client.json";
const CLOUD_REDIRECT_URI = "https://cloud-client.example.test/oauth/callback";
const CLOUD_CELL_TOKEN_KEY = randomBytes(32).toString("hex");
const ORIGINAL_CLOUD_ENABLED = process.env.EXOMEM_CLOUD_ENABLED;
let cloudClientResolutions = 0;
// Item 6 / security review finding 7: whether a mocked cloud grant "owns" a
// non-deleted cell row, i.e. what assertGrantOwnsCloudCell answers. true by
// default so every existing Cloud-flagged test (none of which are about this
// finding) keeps passing without having to know about it.
let cloudGrantOwnsCell = true;
let cloudGrantOwnershipChecks = 0;
class CloudPrincipalHasNoCellErrorMock extends Error {}
// Security review finding 11: the invite route's admission call under Cloud.
let cloudAdmissionError: Error | null = null;
let cloudAdmitCalls: Array<Record<string, unknown>> = [];

// Lane C follow-up ruling: a client that was Cloud-admitted when its
// continuation was minted, but has since lost Cloud admission, would still
// pass the HOSTED resolver's whole-cohort / marketplace-reviewer-bootstrap
// branches -- the mocks below simulate exactly that pass-through, on a
// dedicated client id kept separate from CLOUD_CLIENT_ID so the trap comment
// above (assert.equal(oauthClientResolutions, 0) at mint time) still holds
// for every other Cloud-flagged test. resolveOAuthContinuationToken must
// refuse re-validation once this flag flips false, proving it never falls
// back to the hosted resolver for a Cloud continuation.
const REVOKED_CLOUD_CLIENT_ID = "https://revoked-cloud-client.example.test/client.json";
const REVOKED_CLOUD_REDIRECT_URI = "https://revoked-cloud-client.example.test/oauth/callback";
let revokedCloudClientStillCloudAdmitted = true;

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
let approvedRedirectUris = [REDIRECT_URI];
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

function seedCode(
  code: string,
  overrides: { clientId?: string; redirectUri?: string; resource?: string; verifier?: string } = {}
): void {
  codes.set(tokenKey(code), {
    clientId: overrides.clientId ?? CLIENT_ID,
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    resource: overrides.resource ?? RESOURCE,
    pkceChallenge: pkceS256(overrides.verifier ?? VERIFIER),
    consumed: false,
  });
}

function seedRefreshToken(
  token: string,
  input: { familyId: string; policy: boolean; clientId?: string; resource?: string }
): void {
  const clientId = input.clientId ?? CLIENT_ID;
  const resource = input.resource ?? RESOURCE;
  families.set(input.familyId, { clientId, revoked: false });
  refreshCredentials.set(tokenKey(token), {
    familyId: input.familyId,
    clientId,
    resource,
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
  // Cloud config vars (item 4 / task 3.5): harmless while EXOMEM_CLOUD_ENABLED
  // stays unset, since exomemCloudEnabled() gates every reader of them.
  process.env.EXOMEM_CLOUD_MCP_URL = CLOUD_RESOURCE;
  process.env.EXOMEM_CLOUD_MCP_PATH = "/api/exomem/cloud/mcp/v1";
  process.env.EXOMEM_CLOUD_CELL_TOKEN_KEY = CLOUD_CELL_TOKEN_KEY;
  delete process.env.EXOMEM_CLOUD_ENABLED;
  // A deliberately different client/resolver from the hosted mock below: if a
  // route under test called resolveApprovedOAuthClient instead of this one
  // despite EXOMEM_CLOUD_ENABLED being on, CLOUD_CLIENT_ID would never
  // resolve and every Cloud-flagged test would fail at client resolution.
  mock.module("@/lib/exomem-hosted/cloud-oauth", {
    namedExports: {
      resolveApprovedCloudOAuthClient: async (clientId: string) => {
        cloudClientResolutions += 1;
        if (clientId === CLOUD_CLIENT_ID) {
          return {
            id: "018f2d91-7c42-7000-8000-000000000099",
            clientId: CLOUD_CLIENT_ID,
            redirectUris: [CLOUD_REDIRECT_URI],
            admissionMode: "pinned" as const,
          };
        }
        if (clientId === REVOKED_CLOUD_CLIENT_ID && revokedCloudClientStillCloudAdmitted) {
          return {
            id: "018f2d91-7c42-7000-8000-000000000098",
            clientId: REVOKED_CLOUD_CLIENT_ID,
            redirectUris: [REVOKED_CLOUD_REDIRECT_URI],
            admissionMode: "pinned" as const,
          };
        }
        return null;
      },
      // D2's scope rule, real logic (pure, no DB) rather than a stub: an
      // omitted scope receives both; a subset is refused.
      resolveCloudAuthorizationScope: (requestedScope: string): string | null => {
        const requested = requestedScope.trim();
        if (!requested) return "exomem.read exomem.write";
        const scopes = new Set(requested.split(" ").filter(Boolean));
        if (!scopes.has("exomem.read") || !scopes.has("exomem.write")) return null;
        return requested;
      },
      // Item 6 / security review finding 7.
      assertGrantOwnsCloudCell: async (_grantId: string) => {
        cloudGrantOwnershipChecks += 1;
        if (!cloudGrantOwnsCell) throw new CloudPrincipalHasNoCellErrorMock();
      },
      CloudPrincipalHasNoCellError: CloudPrincipalHasNoCellErrorMock,
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-admission", {
    namedExports: {
      admitFirstCloudOAuthInviteAtomic: async (input: Record<string, unknown>) => {
        cloudAdmitCalls.push(input);
        if (cloudAdmissionError) throw cloudAdmissionError;
        return {
          tenantId: "cloud-tenant-1",
          sessionId: "cloud-session-1",
          grantId: "cloud-grant-1",
          cellId: "aaaaaaaaaaaaaaaa",
        };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      resolveApprovedOAuthClient: async (clientId: string) => {
        oauthClientResolutions += 1;
        if (oauthClientResolutionError) throw oauthClientResolutionError;
        if (clientId === CLIENT_ID) {
          return {
            id: "018f2d91-7c42-7000-8000-000000000041",
            clientId: CLIENT_ID,
            redirectUris: approvedRedirectUris,
            admissionMode: "pinned",
          };
        }
        // Lane C follow-up ruling, test 1: REVOKED_CLOUD_CLIENT_ID always
        // resolves here, unconditionally -- standing in for the hosted
        // resolver's whole-cohort / marketplace-reviewer-bootstrap
        // OR-branches, which do not model Cloud admission at all and must
        // never be allowed to re-validate a Cloud continuation.
        if (clientId === REVOKED_CLOUD_CLIENT_ID) {
          return {
            id: "018f2d91-7c42-7000-8000-000000000097",
            clientId: REVOKED_CLOUD_CLIENT_ID,
            redirectUris: [REVOKED_CLOUD_REDIRECT_URI],
            admissionMode: "pinned",
          };
        }
        return null;
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

after(() => {
  mock.reset();
  if (ORIGINAL_CLOUD_ENABLED === undefined) delete process.env.EXOMEM_CLOUD_ENABLED;
  else process.env.EXOMEM_CLOUD_ENABLED = ORIGINAL_CLOUD_ENABLED;
});

beforeEach(() => {
  continuations.clear();
  attached.length = 0;
  admitCalls = [];
  admissionError = null;
  rateLimitAllowed = true;
  oauthClientResolutions = 0;
  oauthClientResolutionError = null;
  approvedRedirectUris = [REDIRECT_URI];
  tokenStoreCalls = 0;
  codes.clear();
  refreshCredentials.clear();
  families.clear();
  revocableCredentialFamilies.clear();
  cloudClientResolutions = 0;
  cloudGrantOwnsCell = true;
  cloudGrantOwnershipChecks = 0;
  cloudAdmissionError = null;
  cloudAdmitCalls = [];
  revokedCloudClientStillCloudAdmitted = true;
  delete process.env.EXOMEM_CLOUD_ENABLED;
});

// Belt-and-suspenders: a test that sets EXOMEM_CLOUD_ENABLED and throws
// before its own finally block must not leak the flag into later tests.
afterEach(() => {
  delete process.env.EXOMEM_CLOUD_ENABLED;
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

  it("keeps invalid clients local and logs only redirect URI fingerprints", async () => {
    const { GET } = await import("../authorize/route");
    const rawClient = "raw-client-sentinel";
    const rawState = "raw-state-sentinel";
    const rawResource = "https://resource.example.test/raw-resource-sentinel";
    const requestedRedirect = "https://attacker.example.test/raw-redirect-sentinel";
    const approvedRedirects = [
      "https://client.example.test/approved-redirect-sentinel-a",
      "https://client.example.test/approved-redirect-sentinel-b",
    ];
    const logged: unknown[][] = [];
    const originalError = console.error;
    approvedRedirectUris = approvedRedirects;
    console.error = (...args: unknown[]) => logged.push(args);

    try {
      const invalidClient = await GET(authorizeRequest(rawState, { client_id: rawClient }));
      const invalidRedirect = await GET(
        authorizeRequest(rawState, {
          redirect_uri: requestedRedirect,
          resource: rawResource,
        })
      );
      const missingRedirectUrl = new URL(authorizeRequest(rawState, { resource: rawResource }).url);
      missingRedirectUrl.searchParams.delete("redirect_uri");
      const missingRedirect = await GET(
        new Request(missingRedirectUrl, { headers: { "x-forwarded-for": "203.0.113.10" } })
      );

      assert.equal(invalidClient.status, 400);
      assert.deepEqual(await invalidClient.json(), { error: "invalid_request" });
      assert.equal(invalidClient.headers.get("location"), null);
      assert.equal(invalidClient.headers.get("cache-control"), "no-store");
      assert.equal(invalidClient.headers.get("referrer-policy"), "no-referrer");
      assert.equal(invalidRedirect.status, 400);
      assert.deepEqual(await invalidRedirect.json(), { error: "invalid_request" });
      assert.equal(invalidRedirect.headers.get("location"), null);
      assert.equal(invalidRedirect.headers.get("cache-control"), "no-store");
      assert.equal(invalidRedirect.headers.get("referrer-policy"), "no-referrer");
      assert.equal(missingRedirect.status, 400);
      assert.deepEqual(await missingRedirect.json(), { error: "invalid_request" });
      assert.equal(missingRedirect.headers.get("location"), null);
      assert.equal(missingRedirect.headers.get("cache-control"), "no-store");
      assert.equal(missingRedirect.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(logged, [
        [
          {
            event: "exomem_oauth_authorize_rejection",
            stage: "client_resolution",
          },
        ],
        [
          {
            event: "exomem_oauth_authorize_rejection",
            stage: "redirect_validation",
            requested_redirect_present: true,
            requested_redirect_sha256: createHash("sha256")
              .update(requestedRedirect, "utf8")
              .digest("hex"),
            approved_redirects_sha256: approvedRedirects.map((redirect) =>
              createHash("sha256").update(redirect, "utf8").digest("hex")
            ),
          },
        ],
        [
          {
            event: "exomem_oauth_authorize_rejection",
            stage: "redirect_validation",
            requested_redirect_present: false,
            approved_redirects_sha256: approvedRedirects.map((redirect) =>
              createHash("sha256").update(redirect, "utf8").digest("hex")
            ),
          },
        ],
      ]);
      assert.deepEqual(
        logged.map(([entry]) => Object.keys(entry as Record<string, unknown>).sort()),
        [
          ["event", "stage"],
          [
            "approved_redirects_sha256",
            "event",
            "requested_redirect_present",
            "requested_redirect_sha256",
            "stage",
          ],
          ["approved_redirects_sha256", "event", "requested_redirect_present", "stage"],
        ]
      );
      const serializedLogs = JSON.stringify(logged);
      for (const rawSentinel of [
        rawClient,
        rawState,
        rawResource,
        requestedRedirect,
        ...approvedRedirects,
      ])
        assert.equal(serializedLogs.includes(rawSentinel), false);
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
    assert.equal(
      continuityCookies.every((value) => /Path=\//i.test(value)),
      true
    );
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

  // RFC 8252 section 7.3: a native client registers a loopback IP literal
  // redirect. Next.js hands the route a NextRequest whose `url` rewrites the
  // first loopback literal anywhere in the URL -- including inside the encoded
  // redirect_uri -- to "localhost", so an exact match against the registered
  // 127.0.0.1 redirect could never succeed.
  describe("loopback redirect_uri through the NextRequest Next.js hands the route", () => {
    const LOOPBACK_REDIRECT = "http://127.0.0.1:33418/callback";

    function nextAuthorizeRequest(redirectUri: string, state = "loopback-state"): NextRequest {
      return new NextRequest(new URL(authorizeRequest(state, { redirect_uri: redirectUri }).url), {
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
    }

    it("is rewritten to localhost by NextRequest.url (the defect this guards)", () => {
      const request = nextAuthorizeRequest(LOOPBACK_REDIRECT);
      assert.equal(
        new URL(request.url).searchParams.get("redirect_uri"),
        "http://localhost:33418/callback"
      );
    });

    // Next.js wraps the request in a Proxy for routes that are not
    // force-dynamic, and the raw URL cannot be read through that Proxy.
    it("keeps the authorize route force-dynamic so it receives the unproxied request", async () => {
      assert.equal((await import("../authorize/route")).dynamic, "force-dynamic");
    });

    it("authorizes a client registered with a 127.0.0.1 redirect and binds that exact redirect", async () => {
      const { GET } = await import("../authorize/route");
      approvedRedirectUris = [LOOPBACK_REDIRECT];
      const response = await GET(nextAuthorizeRequest(LOOPBACK_REDIRECT));
      assert.equal(response.status, 303);
      assert.equal(new URL(response.headers.get("location")!).pathname, "/exomem/authorize");
      const stored = continuations.get(
        digestKey(digestSecret(cookie(response, "exomem_oauth_tx")))
      );
      assert.equal(stored?.redirectUri, LOOPBACK_REDIRECT);
    });

    it("still refuses a loopback redirect that differs in host, port, path or scheme", async () => {
      const { GET } = await import("../authorize/route");
      approvedRedirectUris = [LOOPBACK_REDIRECT];
      for (const requested of [
        "http://localhost:33418/callback",
        "http://127.0.0.1:33419/callback",
        "http://127.0.0.1:33418/callback/",
        "http://127.0.0.1:33418/other",
        "https://127.0.0.1:33418/callback",
        "http://127.0.0.2:33418/callback",
        "http://[::1]:33418/callback",
      ]) {
        const response = await GET(nextAuthorizeRequest(requested));
        assert.equal(response.status, 400, requested);
        assert.equal(response.headers.get("location"), null, requested);
      }
      assert.equal(continuations.size, 0);
    });

    it("does not treat 127.0.0.1 as a registered localhost redirect", async () => {
      const { GET } = await import("../authorize/route");
      approvedRedirectUris = ["http://localhost:33418/callback"];
      const response = await GET(nextAuthorizeRequest(LOOPBACK_REDIRECT));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
      assert.equal(continuations.size, 0);
    });

    it("sends a post-validation error to the raw registered loopback redirect", async () => {
      const { GET } = await import("../authorize/route");
      approvedRedirectUris = [LOOPBACK_REDIRECT];
      // The state carries a loopback literal too: the whole query must reach
      // the client exactly as it sent it.
      const raw = `${BASE_URL}/api/exomem/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: LOOPBACK_REDIRECT,
        resource: RESOURCE,
        scope: "exomem.read",
        state: "loop.127.0.0.1",
        code_challenge: pkceS256(VERIFIER),
        code_challenge_method: "plain",
      })}`;
      const response = await GET(
        new NextRequest(raw, { headers: { "x-forwarded-for": "203.0.113.10" } })
      );
      assert.equal(response.status, 303);
      const callback = new URL(response.headers.get("location")!);
      assert.equal(`${callback.origin}${callback.pathname}`, "http://127.0.0.1:33418/callback");
      assert.equal(callback.searchParams.get("error"), "invalid_request");
      assert.equal(callback.searchParams.get("state"), "loop.127.0.0.1");
    });
  });

  // Item 4 / task 3.5: under EXOMEM_CLOUD_ENABLED, /authorize must resolve the
  // client and bind the resource through cloud-oauth.ts's
  // resolveApprovedCloudOAuthClient, not the hosted resolver -- mirroring how
  // admission already switched fully to Cloud for redeem/invite (items 1/3).
  // Before this wiring exists the route always resolves via the hosted
  // mock, which does not know CLOUD_CLIENT_ID, so this fails closed (400)
  // rather than opening a continuation.
  it("flag on: authorizes through the Cloud OAuth client resolver and binds the Cloud resource", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { GET } = await import("../authorize/route");
    const response = await GET(
      authorizeRequest("cloud-client-state", {
        client_id: CLOUD_CLIENT_ID,
        redirect_uri: CLOUD_REDIRECT_URI,
        resource: CLOUD_RESOURCE,
        // D2: a Cloud-resource grant always needs both scopes. The suite's
        // default "exomem.read offline_access" is a valid hosted-resource
        // request but an invalid Cloud one (see the invalid_scope test below).
        scope: "exomem.read exomem.write",
      })
    );
    assert.equal(response.status, 303);
    const transaction = cookie(response, "exomem_oauth_tx");
    const stored = continuations.get(digestKey(digestSecret(transaction)));
    assert.ok(stored);
    assert.deepEqual(
      { clientId: stored.clientId, redirectUri: stored.redirectUri, resource: stored.resource },
      { clientId: CLOUD_CLIENT_ID, redirectUri: CLOUD_REDIRECT_URI, resource: CLOUD_RESOURCE }
    );
    assert.equal(oauthClientResolutions, 0);
    assert.equal(cloudClientResolutions, 1);
  });

  // Security review finding 2: a cell exposes one fixed non-owner principal
  // and cannot itself enforce a read-only grant, so a Cloud-resource request
  // naming only a subset of exomem.read/exomem.write is refused outright,
  // and an omitted scope receives both rather than falling back to hosted's
  // ordinary subset-accepting rule.
  it("flag on: refuses a subset scope with invalid_scope, and grants both when scope is omitted", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { GET } = await import("../authorize/route");

    const subset = await GET(
      authorizeRequest("cloud-subset-state", {
        client_id: CLOUD_CLIENT_ID,
        redirect_uri: CLOUD_REDIRECT_URI,
        resource: CLOUD_RESOURCE,
        scope: "exomem.read",
      })
    );
    assert.equal(subset.status, 303);
    const subsetLocation = new URL(subset.headers.get("location")!);
    assert.equal(subsetLocation.origin + subsetLocation.pathname, CLOUD_REDIRECT_URI);
    assert.equal(subsetLocation.searchParams.get("error"), "invalid_scope");
    assert.equal(subsetLocation.searchParams.get("state"), "cloud-subset-state");
    assert.ok(subsetLocation.searchParams.get("error_description"));
    assert.equal(subset.headers.get("set-cookie"), null);

    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLOUD_CLIENT_ID,
      redirect_uri: CLOUD_REDIRECT_URI,
      resource: CLOUD_RESOURCE,
      state: "cloud-omitted-scope-state",
      code_challenge: pkceS256(VERIFIER),
      code_challenge_method: "S256",
    });
    const omitted = await GET(
      new Request(`${BASE_URL}/api/exomem/oauth/authorize?${query}`, {
        headers: { "x-forwarded-for": "203.0.113.10" },
      })
    );
    assert.equal(omitted.status, 303);
    const transaction = cookie(omitted, "exomem_oauth_tx");
    const stored = continuations.get(digestKey(digestSecret(transaction)));
    assert.ok(stored);
    assert.deepEqual(new Set(stored.scopes), new Set(["exomem.read", "exomem.write"]));
  });

  it("flag off: authorize keeps resolving through the hosted client resolver and never touches cloud-oauth", async () => {
    const { GET } = await import("../authorize/route");
    const response = await GET(authorizeRequest());
    assert.equal(response.status, 303);
    assert.equal(cloudClientResolutions, 0);
    assert.ok(oauthClientResolutions >= 1);
  });

  // A continuation cookie from an earlier attempt used to refuse this one with
  // `invalid_request`, which left the browser holding it unable to start ANY
  // authorization: every retry failed the same way and the only escape was
  // clearing site cookies by hand. That is what cost the 2026-08-22 promotion
  // window. Superseding is also the safer behaviour -- refusing lets anyone who
  // can make this browser touch /authorize lock the victim out with a planted
  // cookie.
  it("supersedes a continuation left over from an earlier attempt", async () => {
    const { GET } = await import("../authorize/route");
    const first = await GET(authorizeRequest("first-state"));
    assert.equal(first.status, 303);
    const staleTransaction = cookie(first, "exomem_oauth_tx");
    const staleNonce = cookie(first, "exomem_oauth_form_nonce");

    const retry = await GET(
      new Request(authorizeRequest("second-state").url, {
        headers: {
          "x-forwarded-for": "203.0.113.10",
          cookie: `exomem_oauth_tx=${staleTransaction}; exomem_oauth_form_nonce=${staleNonce}`,
        },
      })
    );

    assert.equal(retry.status, 303, "a leftover continuation must not dead-end the retry");
    const freshTransaction = cookie(retry, "exomem_oauth_tx");
    const freshNonce = cookie(retry, "exomem_oauth_form_nonce");
    assert.notEqual(freshTransaction, staleTransaction, "the retry must mint its own transaction");
    assert.notEqual(freshNonce, staleNonce, "the retry must mint its own form nonce");

    // Newest wins: the browser is left holding only the fresh continuation, so a
    // planted transaction is discarded rather than carried forward.
    assert.ok(continuations.get(digestKey(digestSecret(freshTransaction))));
    assert.equal(
      retry.headers.get("location")?.includes(freshTransaction),
      false,
      "the transaction must stay out of the redirect target"
    );
  });

  it("keeps concurrent first continuations distinct and re-renders a stale confirmation", async () => {
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
    // The invariant this test exists for is unchanged and asserted below: a
    // mismatched confirmation mints nothing. What changed is the affordance --
    // a stale confirmation is now answered with the consent page for the
    // transaction the caller's OWN cookie names, rather than a bare 400 the
    // operator cannot act on. No cross-transaction disclosure: the handle sent
    // back is derived from the cookie they already presented.
    assert.equal(stale.status, 303);
    assert.equal(
      new URL(stale.headers.get("location")!).searchParams.get("confirmation"),
      confirmation(second)
    );
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
      clearedContinuityCookies.every((value) => /Path=\//i.test(value) && /Max-Age=0/i.test(value)),
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

  // Lane C follow-up ruling, test 1 (red-first): a continuation minted for
  // REVOKED_CLOUD_CLIENT_ID while it was Cloud-admitted, whose client then
  // loses Cloud admission before re-validation, must be refused -- both at
  // the invite POST and at /authorize/complete, which also calls
  // resolveOAuthContinuation. The hosted resolver mock above still resolves
  // this client unconditionally (standing in for the whole-cohort /
  // marketplace-reviewer-bootstrap branches), so a pass here would mean
  // resolveOAuthContinuationToken fell back to it instead of staying on the
  // Cloud resolver.
  it("flag on: refuses re-validation for a continuation whose client has since lost Cloud admission, at both the invite POST and authorize/complete", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { GET } = await import("../authorize/route");
    const { POST: invitePost } = await import("../authorize/invite/route");
    const { POST: completePost } = await import("../authorize/complete/route");

    async function mintThenRevoke(state: string) {
      revokedCloudClientStillCloudAdmitted = true;
      const started = await GET(
        authorizeRequest(state, {
          client_id: REVOKED_CLOUD_CLIENT_ID,
          redirect_uri: REVOKED_CLOUD_REDIRECT_URI,
          resource: CLOUD_RESOURCE,
          scope: "exomem.read exomem.write",
        })
      );
      assert.equal(started.status, 303);
      assert.equal(cloudClientResolutions > 0, true);
      const transaction = cookie(started, "exomem_oauth_tx");
      const nonce = cookie(started, "exomem_oauth_form_nonce");
      // Revoked between minting and re-validation.
      revokedCloudClientStillCloudAdmitted = false;
      return { started, transaction, nonce };
    }

    const invite = await mintThenRevoke("revoked-cloud-invite-state");
    const inviteResponse = await invitePost(
      new Request(`${BASE_URL}/api/exomem/oauth/authorize/invite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: `exomem_oauth_tx=${invite.transaction}`,
        },
        body: JSON.stringify({
          token: Buffer.alloc(32, 0x47).toString("base64url"),
          nonce: invite.nonce,
        }),
      })
    );
    assert.equal(inviteResponse.status, 400);
    assert.deepEqual(await inviteResponse.json(), { error: "invalid_request" });
    assert.equal(cloudAdmitCalls.length, 0);

    const complete = await mintThenRevoke("revoked-cloud-complete-state");
    const completeResponse = await completePost(
      completionRequest({
        transaction: complete.transaction,
        nonce: complete.nonce,
        confirmation: confirmation(complete.started),
      })
    );
    assert.equal(completeResponse.status, 400);
    assert.deepEqual(await completeResponse.json(), { error: "invalid_request" });
    assert.equal(attached.length, 0);
  });

  // Lane C follow-up ruling, test 2: the positive mirror of the red-first
  // test above -- an ordinary Cloud-admitted client (never revoked) still
  // completes the whole invite flow to a 303 redirect once
  // resolveOAuthContinuationToken re-validates it through the Cloud
  // resolver, proving the fix does not over-refuse.
  it("flag on: an ordinary Cloud-admitted client's continuation still completes", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/invite/route");
    const started = await GET(
      authorizeRequest("cloud-happy-path-state", {
        client_id: CLOUD_CLIENT_ID,
        redirect_uri: CLOUD_REDIRECT_URI,
        resource: CLOUD_RESOURCE,
        scope: "exomem.read exomem.write",
      })
    );
    assert.equal(started.status, 303);
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
        body: JSON.stringify({ token: Buffer.alloc(32, 0x48).toString("base64url"), nonce }),
      })
    );
    assert.equal(response.status, 303);
    const destination = new URL(response.headers.get("location")!);
    assert.equal(destination.origin + destination.pathname, CLOUD_REDIRECT_URI);
    assert.equal(destination.searchParams.get("state"), "cloud-happy-path-state");
    assert.ok(destination.searchParams.get("code"));
    assert.equal(cloudAdmitCalls.length, 1);
  });

  // Security review finding 11: the mirror of the hosted case above, under
  // EXOMEM_CLOUD_ENABLED, and the flag-gating itself.
  //
  // The continuation is minted through the real Cloud client/resource (flag
  // on for both the GET and the invite POST), now that
  // resolveOAuthContinuationToken re-validates through the Cloud resolver
  // under the flag (the lane C follow-up ruling above) instead of the earlier
  // workaround of minting through the hosted client and only flipping the
  // flag for the POST.
  it("flag on: returns temporarily_unavailable for Cloud's HOSTED_ADMISSION_CLOSED, but not for the hosted-only CAPACITY_UNAVAILABLE code", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { ExomemHostedError } = await import("@/lib/exomem-hosted/errors");
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/invite/route");

    async function inviteAttempt(state: string): Promise<Response> {
      const started = await GET(
        authorizeRequest(state, {
          client_id: CLOUD_CLIENT_ID,
          redirect_uri: CLOUD_REDIRECT_URI,
          resource: CLOUD_RESOURCE,
          scope: "exomem.read exomem.write",
        })
      );
      assert.equal(started.status, 303);
      const transaction = cookie(started, "exomem_oauth_tx");
      const nonce = cookie(started, "exomem_oauth_form_nonce");
      return POST(
        new Request(`${BASE_URL}/api/exomem/oauth/authorize/invite`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE_URL,
            cookie: `exomem_oauth_tx=${transaction}`,
          },
          body: JSON.stringify({ token: Buffer.alloc(32, 0x46).toString("base64url"), nonce }),
        })
      );
    }

    cloudAdmissionError = new ExomemHostedError({
      code: "HOSTED_ADMISSION_CLOSED",
      status: 503,
      message: "exomem cloud is temporarily closed",
      retryable: true,
    });
    const closed = await inviteAttempt("cloud-capacity-state");
    assert.equal(closed.status, 503);
    assert.equal((await closed.json()).error, "temporarily_unavailable");

    // The defensive half of the fix: a code the active (Cloud) admission
    // path could never actually throw must not be mapped to the same
    // reassuring 503 -- it surfaces as an ordinary access denial instead of
    // being silently absorbed as a plausible-looking retryable outage.
    cloudAdmissionError = new ExomemHostedError({
      code: "CAPACITY_UNAVAILABLE",
      status: 503,
      message: "hosted capacity is temporarily unavailable",
      retryable: true,
    });
    const mismatched = await inviteAttempt("cloud-capacity-state-2");
    assert.equal(mismatched.status, 403);
    assert.equal((await mismatched.json()).error, "access_denied");
    assert.equal(cloudAdmitCalls.length, 2);
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

  // The MCP Python SDK draws its verifier from the full RFC 7636 unreserved set,
  // "." and "~" included. A base64url-only grammar refused ~98% of its exchanges
  // at code_shape before the code was ever looked up.
  it("exchanges a code whose verifier uses RFC 7636's '.' and '~'", async () => {
    const { POST } = await import("../token/route");
    const verifier = `${"Ab9-_".repeat(9)}.~.~`;
    const code = Buffer.alloc(32, 0x6e).toString("base64url");
    seedCode(code, { redirectUri: "http://127.0.0.1:33418/callback", verifier });
    const exchange = (codeVerifier: string) =>
      POST(
        new Request(`${BASE_URL}/api/exomem/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID,
            redirect_uri: "http://127.0.0.1:33418/callback",
            code_verifier: codeVerifier,
            resource: RESOURCE,
          }),
        })
      );
    for (const malformed of [
      verifier.slice(0, 42),
      `${verifier}${"~".repeat(129 - verifier.length)}`,
      `${verifier.slice(0, 48)}+`,
    ]) {
      const refused = await exchange(malformed);
      assert.equal(refused.status, 400, malformed);
      assert.equal(codes.get(tokenKey(code))?.consumed, false);
    }
    const response = await exchange(verifier);
    assert.equal(response.status, 200);
    assert.equal(codes.get(tokenKey(code))?.consumed, true);
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

  // Item 4 / task 3.5: token issuance binds the exact Cloud resource under
  // EXOMEM_CLOUD_ENABLED, refusing a code minted for one resource when
  // presented against the other. Before this wiring exists the route accepts
  // only the single hardcoded hosted resource, so both the correct-direction
  // Cloud exchange and the cross-resource refusals fail for the wrong
  // reason (every Cloud-resource request is rejected outright).
  it("flag on: exchanges a Cloud-resource code only against the Cloud resource, refusing it in both cross-resource directions", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { POST } = await import("../token/route");
    const cloudCode = Buffer.alloc(32, 0x71).toString("base64url");
    const hostedCode = Buffer.alloc(32, 0x72).toString("base64url");
    seedCode(cloudCode, {
      clientId: CLOUD_CLIENT_ID,
      redirectUri: CLOUD_REDIRECT_URI,
      resource: CLOUD_RESOURCE,
    });
    seedCode(hostedCode);

    const cloudAgainstHosted = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: cloudCode,
          client_id: CLOUD_CLIENT_ID,
          redirect_uri: CLOUD_REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: RESOURCE,
        }),
      })
    );
    assert.equal(cloudAgainstHosted.status, 400);
    assert.equal(codes.get(tokenKey(cloudCode))?.consumed, false);

    const hostedAgainstCloud = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: hostedCode,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: CLOUD_RESOURCE,
        }),
      })
    );
    assert.equal(hostedAgainstCloud.status, 400);
    assert.equal(codes.get(tokenKey(hostedCode))?.consumed, false);

    const cloudCorrect = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: cloudCode,
          client_id: CLOUD_CLIENT_ID,
          redirect_uri: CLOUD_REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: CLOUD_RESOURCE,
        }),
      })
    );
    assert.equal(cloudCorrect.status, 200);
    assert.equal(codes.get(tokenKey(cloudCode))?.consumed, true);

    const hostedCorrect = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: hostedCode,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: RESOURCE,
        }),
      })
    );
    assert.equal(hostedCorrect.status, 200);
    assert.equal(codes.get(tokenKey(hostedCode))?.consumed, true);
  });

  it("flag off: a Cloud-resource token request is refused even though a matching code exists", async () => {
    const { POST } = await import("../token/route");
    const cloudCode = Buffer.alloc(32, 0x73).toString("base64url");
    seedCode(cloudCode, {
      clientId: CLOUD_CLIENT_ID,
      redirectUri: CLOUD_REDIRECT_URI,
      resource: CLOUD_RESOURCE,
    });
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: cloudCode,
          client_id: CLOUD_CLIENT_ID,
          redirect_uri: CLOUD_REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: CLOUD_RESOURCE,
        }),
      })
    );
    assert.equal(response.status, 400);
    assert.equal(codes.get(tokenKey(cloudCode))?.consumed, false);
  });

  // Item 6 / security review finding 7: the hosted-shared minting queries
  // know nothing about Cloud cells, so this is the post-condition the route
  // itself applies before ever revealing minted material — for both code
  // exchange and refresh rotation.
  it("flag on: refuses to reveal a minted token when the grant's tenant owns no live Cloud cell", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    cloudGrantOwnsCell = false;
    const { POST } = await import("../token/route");
    const cloudCode = Buffer.alloc(32, 0x75).toString("base64url");
    seedCode(cloudCode, {
      clientId: CLOUD_CLIENT_ID,
      redirectUri: CLOUD_REDIRECT_URI,
      resource: CLOUD_RESOURCE,
    });
    const codeResponse = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: cloudCode,
          client_id: CLOUD_CLIENT_ID,
          redirect_uri: CLOUD_REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: CLOUD_RESOURCE,
        }),
      })
    );
    assert.equal(codeResponse.status, 400);
    assert.deepEqual(await codeResponse.json(), { error: "invalid_grant" });
    assert.ok(cloudGrantOwnershipChecks >= 1);

    const cloudRefresh = Buffer.alloc(32, 0x76).toString("base64url");
    seedRefreshToken(cloudRefresh, {
      familyId: "cloud-no-cell-refresh-family",
      policy: true,
      clientId: CLOUD_CLIENT_ID,
      resource: CLOUD_RESOURCE,
    });
    const refreshResponse = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: cloudRefresh,
          client_id: CLOUD_CLIENT_ID,
          resource: CLOUD_RESOURCE,
        }),
      })
    );
    assert.equal(refreshResponse.status, 400);
    assert.deepEqual(await refreshResponse.json(), { error: "invalid_grant" });

    // A hosted-resource request must never even consult the Cloud check.
    cloudGrantOwnershipChecks = 0;
    const hostedCode = Buffer.alloc(32, 0x77).toString("base64url");
    seedCode(hostedCode);
    const hostedResponse = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: hostedCode,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: RESOURCE,
        }),
      })
    );
    assert.equal(hostedResponse.status, 200);
    assert.equal(cloudGrantOwnershipChecks, 0);
  });

  it("flag on: refresh rotation binds the exact Cloud resource, refusing cross-resource rotation", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { POST } = await import("../token/route");
    const cloudRefresh = Buffer.alloc(32, 0x74).toString("base64url");
    seedRefreshToken(cloudRefresh, {
      familyId: "cloud-refresh-family-1",
      policy: true,
      clientId: CLOUD_CLIENT_ID,
      resource: CLOUD_RESOURCE,
    });

    const againstHosted = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: cloudRefresh,
          client_id: CLOUD_CLIENT_ID,
          resource: RESOURCE,
        }),
      })
    );
    assert.equal(againstHosted.status, 400);
    assert.equal(refreshCredentials.get(tokenKey(cloudRefresh))?.consumed, false);

    const correct = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: cloudRefresh,
          client_id: CLOUD_CLIENT_ID,
          resource: CLOUD_RESOURCE,
        }),
      })
    );
    assert.equal(correct.status, 200);
    assert.equal(refreshCredentials.get(tokenKey(cloudRefresh))?.consumed, true);
  });

  it("exchanges a code from a client that also sent an unverified client assertion", async () => {
    // A client whose metadata prefers private_key_jwt may still send a client
    // assertion after negotiating down to the `none` we advertise. We discard
    // it rather than reject the exchange; PKCE remains the proof that binds.
    const { POST } = await import("../token/route");
    const code = Buffer.alloc(32, 0x63).toString("base64url");
    seedCode(code);
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: RESOURCE,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: "e30.e30.not-verified",
          scope: "exomem.read",
        }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(codes.get(tokenKey(code))?.consumed, true);
  });

  it("still refuses a token request whose recognized fields are wrong for the grant", async () => {
    // Dropping unknown fields must not weaken the grant-shape check: a
    // refresh_token riding along with an authorization_code stays fatal.
    const { POST } = await import("../token/route");
    const code = Buffer.alloc(32, 0x64).toString("base64url");
    seedCode(code);
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: RESOURCE,
          refresh_token: "should-not-be-here",
        }),
      })
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
    assert.equal(codes.get(tokenKey(code))?.consumed, false);
  });

  it("still refuses a duplicated token field even when unknown fields are ignored", async () => {
    const { POST } = await import("../token/route");
    const code = Buffer.alloc(32, 0x65).toString("base64url");
    seedCode(code);
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body:
          `grant_type=authorization_code&code=${code}&client_id=${encodeURIComponent(CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_verifier=${VERIFIER}` +
          `&resource=${encodeURIComponent(RESOURCE)}&client_assertion=a&client_assertion=b`,
      })
    );
    assert.equal(response.status, 400);
    assert.equal(codes.get(tokenKey(code))?.consumed, false);
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
