import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { POST as completeRoute } from "../../../app/api/exomem/oauth/authorize/complete/route";
import { POST as declineRoute } from "../../../app/api/exomem/oauth/authorize/decline/route";
import { POST as disconnectRoute } from "../../../app/api/exomem/apps/[id]/disconnect/route";
import { randomCloudCellId } from "../cloud-admission";
import { findCloudOAuthAccessToken, recordCloudAppUse } from "../cloud-oauth";
import { loadConsentView } from "../consent-view";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { setOperationalEventSinkForTests } from "../observability";
import { consumeDeclinedOAuthAuthorization } from "../oauth-consent";
import { createOAuthContinuation, oauthConsentPath } from "../oauth-continuity";
import {
  attachExistingOwnerAuthorizationAtomic,
  issueOAuthTokensFromCodeAtomic,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";
import { listOwnerApps } from "../owner-apps";
import { digestSecret, generateExternalToken, tokenDigest } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Consent outcomes and connected apps (launch-exomem-cloud-web, B and C)
// against real PostgreSQL, through the same lookups the gateway and the token
// endpoint use.

const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
const ORIGIN = "https://exomem.example.test";
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

const TEST_ENV = {
  EXOMEM_CLOUD_MCP_URL: CLOUD_RESOURCE,
  EXOMEM_CLOUD_MCP_PATH: "/mcp/v1",
  EXOMEM_CONTROL_PLANE_KEY: Buffer.alloc(32, 7).toString("base64url"),
} as const;
const priorEnv: Record<string, string | undefined> = {};

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function interactiveTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await callback(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Owner = {
  userId: string;
  tenantId: string;
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
};

// A paid-up owner with a running cell and a signed-in browser session.
async function newOwner(): Promise<Owner> {
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_users (email) VALUES ($1) RETURNING id",
    [`owner-${randomUUID()}@example.test`]
  );
  const userId = user.rows[0]!.id;
  const tenant = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id, status) VALUES ($1, 'active') RETURNING id",
    [userId]
  );
  const tenantId = tenant.rows[0]!.id;
  await pool!.query(
    `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
     VALUES ($1, 'complimentary', 'complimentary_active', 'active')`,
    [tenantId]
  );
  await pool!.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
    [randomCloudCellId(), tenantId]
  );
  const sessionToken = generateExternalToken();
  const csrfToken = generateExternalToken();
  const session = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
    [userId, tenantId, tokenDigest(sessionToken), digestSecret(csrfToken)]
  );
  return { userId, tenantId, sessionId: session.rows[0]!.id, sessionToken, csrfToken };
}

type Client = { clientId: string; redirectUri: string };

// A self-registered client on an admitted host, as claude.ai and chatgpt.com are.
async function newCimdClient(platform: "claude" | "openai" = "claude"): Promise<Client> {
  const clientId = `https://app-${randomUUID()}.example.test/client.json`;
  const host = new URL(clientId).hostname;
  const redirectUri = `https://${host}/callback`;
  await pool!.query(
    "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [platform, host]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
       cimd_host, client_platform, oauth_client_config_sha256
     ) VALUES (
       $1, 'cimd', true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'),
       $3, now(), 3600, now() + interval '1 hour', $4, $5, $6
     )`,
    [
      clientId,
      JSON.stringify([redirectUri]),
      randomBytes(32),
      host,
      platform,
      randomBytes(32).toString("hex"),
    ]
  );
  return { clientId, redirectUri };
}

type Authorization = { transaction: string; formNonce: string; state: string; challenge: string };

// What /authorize does when an app opens the consent page in a browser.
async function startAuthorization(client: Client): Promise<Authorization> {
  const state = `state-${randomUUID()}`;
  const challenge = `challenge-${randomUUID()}`;
  const started = await createOAuthContinuation({
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    resource: CLOUD_RESOURCE,
    scopes: ["exomem.read", "exomem.write"],
    state,
    codeChallenge: challenge,
    offlineAccess: true,
  });
  assert.ok(started, "the authorization request is created");
  return { ...started, state, challenge };
}

function confirmationOf(transaction: string): string {
  return new URL(oauthConsentPath(transaction), ORIGIN).searchParams.get("confirmation")!;
}

type Connection = { grantId: string; accessDigest: Buffer; refreshDigest: Buffer };

// Connect, then the app's code exchange, through the production statements.
async function connect(owner: Owner, client: Client): Promise<Connection> {
  const authorization = await startAuthorization(client);
  const codeDigest = randomBytes(32);
  const attached = await attachExistingOwnerAuthorizationAtomic({
    sessionId: owner.sessionId,
    transactionDigest: tokenDigest(authorization.transaction)!,
    codeDigest,
    codeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  assert.ok(attached, "the owner connects the app");
  const accessDigest = randomBytes(32);
  const refreshDigest = randomBytes(32);
  const issued = await issueOAuthTokensFromCodeAtomic({
    codeDigest,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    resource: CLOUD_RESOURCE,
    pkceChallenge: authorization.challenge,
    refreshDigest,
    accessDigest,
    accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  assert.ok(issued, "the app exchanges its code for tokens");
  return { grantId: attached.grantId, accessDigest, refreshDigest };
}

function refresh(client: Client, connection: Connection) {
  return rotateOAuthRefreshTokenAtomic({
    refreshDigest: connection.refreshDigest,
    replacementRefreshDigest: randomBytes(32),
    accessDigest: randomBytes(32),
    accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    clientId: client.clientId,
    resource: CLOUD_RESOURCE,
  });
}

function declineRequest(
  authorization: Authorization,
  body: Record<string, unknown>,
  cookie = `exomem_oauth_tx=${authorization.transaction}; exomem_oauth_form_nonce=${authorization.formNonce}`
): Request {
  return new Request(`${ORIGIN}/api/exomem/oauth/authorize/decline`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", cookie },
    body: JSON.stringify(body),
  });
}

function disconnectRequest(
  owner: Owner,
  appId: string
): [Request, { params: Promise<{ id: string }> }] {
  const request = new Request(`${ORIGIN}/api/exomem/apps/${appId}/disconnect`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: new URL(ORIGIN).host,
      "x-exomem-csrf": owner.csrfToken,
      cookie: `exomem_session=${owner.sessionToken}; exomem_csrf=${owner.csrfToken}`,
    },
  });
  return [request, { params: Promise.resolve({ id: appId }) }];
}

async function transactionConsumed(authorization: Authorization): Promise<boolean> {
  const { rows } = await pool!.query<{ consumed: boolean }>(
    `SELECT consumed_at IS NOT NULL AS consumed
     FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1`,
    [tokenDigest(authorization.transaction)]
  );
  return rows[0]!.consumed;
}

async function grantsAndCodesFor(client: Client): Promise<{ grants: number; codes: number }> {
  const { rows } = await pool!.query<{ grants: number; codes: number }>(
    `SELECT
       (SELECT count(*)::int FROM exomem_oauth_grants AS oauth_grant
         JOIN exomem_oauth_clients AS c ON c.id = oauth_grant.client_id WHERE c.client_id = $1) AS grants,
       (SELECT count(*)::int FROM exomem_oauth_authorization_codes AS code
         JOIN exomem_oauth_clients AS c ON c.id = code.client_id WHERE c.client_id = $1) AS codes`,
    [client.clientId]
  );
  return rows[0]!;
}

describe(
  "Exomem consent outcomes and connected apps PostgreSQL integration",
  { skip: !databaseUrl },
  () => {
    before(async () => {
      for (const [key, value] of Object.entries(TEST_ENV)) {
        priorEnv[key] = process.env[key];
        process.env[key] = value;
      }
      setOperationalEventSinkForTests(() => {});
      schema = `consent_apps_it_${randomUUID().replaceAll("-", "")}`;
      await ensureExomemPostgresTestExtensions(databaseUrl!);
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      await applyMigrations({ databaseUrl: scoped.toString() });
      await admin.end();
      pool = new Pool({ connectionString: scoped.toString() });
      __setExomemSqlForTests(taggedSql(pool));
      __setExomemTransactionForTests(interactiveTransaction);
    });

    after(async () => {
      __setExomemSqlForTests(null);
      __setExomemTransactionForTests(null);
      setOperationalEventSinkForTests(null);
      if (pool) await pool.end();
      if (schema) {
        const admin = new Pool({ connectionString: databaseUrl });
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    describe("Not now and Keep it as it is", () => {
      it("answers a double submit once, and sends the app access_denied at its stored redirect", async () => {
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);
        const body = {
          confirmation: confirmationOf(authorization.transaction),
          nonce: authorization.formNonce,
          outcome: "declined",
        };

        const responses = await Promise.all([
          declineRoute(declineRequest(authorization, body)),
          declineRoute(declineRequest(authorization, body)),
        ]);

        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 410]);
        const accepted = responses.find((response) => response.status === 200)!;
        const expected = new URL(client.redirectUri);
        expected.searchParams.set("error", "access_denied");
        expected.searchParams.set("state", authorization.state);
        assert.deepEqual(await accepted.json(), {
          status: "declined",
          redirectUrl: expected.toString(),
          loopback: false,
        });
        assert.equal(accepted.headers.get("cache-control"), "no-store");
        assert.match(accepted.headers.get("set-cookie") ?? "", /exomem_oauth_tx=;/);
        const refused = responses.find((response) => response.status === 410)!;
        assert.deepEqual(await refused.json(), { status: "expired" });
        assert.equal(await transactionConsumed(authorization), true);
        assert.deepEqual(await grantsAndCodesFor(client), { grants: 0, codes: 0 });
      });

      it("consumes the request once even when two declines both pass the request checks", async () => {
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);
        const decline = () =>
          consumeDeclinedOAuthAuthorization({
            transactionDigest: tokenDigest(authorization.transaction)!,
            redirectUri: client.redirectUri,
            sessionId: null,
          });

        assert.deepEqual((await Promise.all([decline(), decline()])).sort(), [false, true]);
      });

      it("consumes nothing when the redirect is not the one stored on the request", async () => {
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);

        const consumed = await consumeDeclinedOAuthAuthorization({
          transactionDigest: tokenDigest(authorization.transaction)!,
          redirectUri: "https://elsewhere.example.test/callback",
          sessionId: null,
        });

        assert.equal(consumed, false);
        assert.equal(await transactionConsumed(authorization), false);
      });

      it("refuses a body that names its own redirect, and leaves the request open", async () => {
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);

        const response = await declineRoute(
          declineRequest(authorization, {
            confirmation: confirmationOf(authorization.transaction),
            nonce: authorization.formNonce,
            outcome: "declined",
            redirect_uri: "https://elsewhere.example.test/callback",
          })
        );

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: "invalid_request" });
        assert.equal(await transactionConsumed(authorization), false);
      });

      it("sends a stale tab to the live request instead of ending it", async () => {
        const client = await newCimdClient();
        const earlier = await startAuthorization(client);
        const live = await startAuthorization(client);

        const response = await declineRoute(
          declineRequest(live, {
            confirmation: confirmationOf(earlier.transaction),
            nonce: earlier.formNonce,
            outcome: "declined",
          })
        );

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          status: "stale",
          consentPath: oauthConsentPath(live.transaction),
        });
        assert.equal(await transactionConsumed(live), false);
      });

      it("refuses a nonce that is not this page's, and leaves the request open", async () => {
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);

        const response = await declineRoute(
          declineRequest(authorization, {
            confirmation: confirmationOf(authorization.transaction),
            nonce: generateExternalToken(),
            outcome: "declined",
          })
        );

        assert.equal(response.status, 400);
        assert.equal(await transactionConsumed(authorization), false);
      });

      it("leaves an existing connection exactly as it was when the owner keeps it", async () => {
        const owner = await newOwner();
        const client = await newCimdClient();
        const existing = await connect(owner, client);
        const before = await pool!.query(
          "SELECT revoked_at, updated_at, authorization_transaction_id FROM exomem_oauth_grants WHERE id = $1",
          [existing.grantId]
        );
        const authorization = await startAuthorization(client);

        const response = await declineRoute(
          declineRequest(
            authorization,
            {
              confirmation: confirmationOf(authorization.transaction),
              nonce: authorization.formNonce,
              outcome: "kept",
            },
            `exomem_oauth_tx=${authorization.transaction}; exomem_oauth_form_nonce=${authorization.formNonce}; exomem_session=${owner.sessionToken}`
          )
        );

        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as { status: string }).status, "kept");
        const afterKeep = await pool!.query(
          "SELECT revoked_at, updated_at, authorization_transaction_id FROM exomem_oauth_grants WHERE id = $1",
          [existing.grantId]
        );
        assert.deepEqual(
          afterKeep.rows[0],
          before.rows[0],
          "the grant is neither revoked nor re-issued"
        );
        assert.deepEqual(await grantsAndCodesFor(client), { grants: 1, codes: 1 });
        assert.ok(await findCloudOAuthAccessToken(existing.accessDigest, CLOUD_RESOURCE));
        // A Connect on the same request afterwards mints nothing.
        assert.equal(
          await attachExistingOwnerAuthorizationAtomic({
            sessionId: owner.sessionId,
            transactionDigest: tokenDigest(authorization.transaction)!,
            codeDigest: randomBytes(32),
            codeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
          }),
          null
        );
      });
    });

    describe("Connect from the consent page's script", () => {
      function completeRequest(owner: Owner, authorization: Authorization): Request {
        return new Request(`${ORIGIN}/api/exomem/oauth/authorize/complete`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
            cookie:
              `exomem_oauth_tx=${authorization.transaction}; ` +
              `exomem_oauth_form_nonce=${authorization.formNonce}; ` +
              `exomem_session=${owner.sessionToken}`,
          },
          body: JSON.stringify({
            confirmation: confirmationOf(authorization.transaction),
            nonce: authorization.formNonce,
          }),
        });
      }

      it("issues one code for a double submit, and the code exchanges for tokens", async () => {
        const owner = await newOwner();
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);

        const responses = await Promise.all([
          completeRoute(completeRequest(owner, authorization)),
          completeRoute(completeRequest(owner, authorization)),
        ]);

        const statuses = responses.map((response) => response.status);
        assert.equal(statuses.filter((status) => status === 200).length, 1, `got ${statuses}`);
        const accepted = responses.find((response) => response.status === 200)!;
        const answer = (await accepted.json()) as Record<string, unknown>;
        assert.equal(answer.status, "connected");
        assert.equal(answer.loopback, false);
        const redirect = new URL(String(answer.redirectUrl));
        assert.equal(`${redirect.origin}${redirect.pathname}`, client.redirectUri);
        assert.equal(redirect.searchParams.get("state"), authorization.state);
        assert.equal(accepted.headers.get("cache-control"), "no-store");
        assert.match(accepted.headers.get("set-cookie") ?? "", /exomem_oauth_tx=;/);
        assert.deepEqual(await grantsAndCodesFor(client), { grants: 1, codes: 1 });

        const issued = await issueOAuthTokensFromCodeAtomic({
          codeDigest: tokenDigest(redirect.searchParams.get("code")!)!,
          clientId: client.clientId,
          redirectUri: client.redirectUri,
          resource: CLOUD_RESOURCE,
          pkceChallenge: authorization.challenge,
          refreshDigest: randomBytes(32),
          accessDigest: randomBytes(32),
          accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        assert.ok(issued, "the page's code is the one the app exchanges");
      });

      it("answers a replay of a finished Connect as expired and mints nothing", async () => {
        const owner = await newOwner();
        const client = await newCimdClient();
        const authorization = await startAuthorization(client);
        const first = await completeRoute(completeRequest(owner, authorization));
        assert.equal(first.status, 200);

        const replay = await completeRoute(completeRequest(owner, authorization));

        assert.equal(replay.status, 410);
        assert.deepEqual(await replay.json(), { status: "expired" });
        assert.deepEqual(await grantsAndCodesFor(client), { grants: 1, codes: 1 });
      });
    });

    describe("connected apps", () => {
      it("refuses a disconnected app's next token use and refresh, and leaves the owner's other app working", async () => {
        const owner = await newOwner();
        const disconnected = await newCimdClient("claude");
        const kept = await newCimdClient("openai");
        const disconnectedConnection = await connect(owner, disconnected);
        const keptConnection = await connect(owner, kept);
        assert.ok(
          await findCloudOAuthAccessToken(disconnectedConnection.accessDigest, CLOUD_RESOURCE)
        );

        const response = await disconnectRoute(
          ...disconnectRequest(owner, disconnectedConnection.grantId)
        );

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "disconnected" });
        assert.equal(
          await findCloudOAuthAccessToken(disconnectedConnection.accessDigest, CLOUD_RESOURCE),
          null
        );
        assert.equal(await refresh(disconnected, disconnectedConnection), null);
        assert.ok(await findCloudOAuthAccessToken(keptConnection.accessDigest, CLOUD_RESOURCE));
        assert.ok(await refresh(kept, keptConnection));
        const listed = await listOwnerApps(owner);
        assert.deepEqual(
          listed.apps.map((app) => app.id),
          [keptConnection.grantId]
        );

        const repeated = await disconnectRoute(
          ...disconnectRequest(owner, disconnectedConnection.grantId)
        );
        assert.equal(repeated.status, 200, "a second disconnect of the same app still succeeds");
      });

      it("answers 404 for any id the list cannot show, and revokes nothing", async () => {
        const owner = await newOwner();
        const otherOwner = await newOwner();
        const client = await newCimdClient();
        const otherConnection = await connect(otherOwner, client);
        // The owner's own grant, but for a resource other than Cloud.
        const elsewhere = await pool!.query<{ id: string }>(
          `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
           SELECT $1, $2, client.id, 'https://elsewhere.example.test/mcp', '{}'
           FROM exomem_oauth_clients AS client WHERE client.client_id = $3
           RETURNING id`,
          [owner.userId, owner.tenantId, client.clientId]
        );

        const foreign = await disconnectRoute(...disconnectRequest(owner, otherConnection.grantId));
        const otherResource = await disconnectRoute(
          ...disconnectRequest(owner, elsewhere.rows[0]!.id)
        );
        const unknownId = await disconnectRoute(...disconnectRequest(owner, randomUUID()));
        const malformed = await disconnectRoute(...disconnectRequest(owner, "not-an-app-id"));

        assert.deepEqual(
          [foreign.status, otherResource.status, unknownId.status, malformed.status],
          [404, 404, 404, 404]
        );
        assert.ok(await findCloudOAuthAccessToken(otherConnection.accessDigest, CLOUD_RESOURCE));
        assert.ok(await refresh(client, otherConnection));
        const untouched = await pool!.query(
          "SELECT revoked_at FROM exomem_oauth_grants WHERE id = $1",
          [elsewhere.rows[0]!.id]
        );
        assert.equal(untouched.rows[0]!.revoked_at, null);
      });

      it("shows when each app last reached its Exomem, and nothing before its first call", async () => {
        const owner = await newOwner();
        const used = await connect(owner, await newCimdClient());
        const unused = await connect(owner, await newCimdClient());
        await recordCloudAppUse(used.grantId);

        const { apps } = await listOwnerApps(owner);
        const lastUsed = new Map(apps.map((app) => [app.id, app.lastUsedAt]));
        assert.ok(lastUsed.get(used.grantId), "the app that called shows its time");
        assert.equal(lastUsed.get(unused.grantId), null);
      });

      it("tells the waiting step an app connected: lastAuthorizedAt moves past the first poll's serverTime", async () => {
        const owner = await newOwner();
        const client = await newCimdClient();
        const first = await connect(owner, client);
        const firstPoll = await listOwnerApps(owner);
        const before = firstPoll.apps.find((app) => app.id === first.grantId)!;
        assert.ok(Date.parse(before.lastAuthorizedAt) <= Date.parse(firstPoll.serverTime));

        // The app connects again, as it does when the owner adds it once more.
        const again = await connect(owner, client);
        const nextPoll = await listOwnerApps(owner);

        assert.equal(again.grantId, first.grantId, "a reconnect updates the same grant");
        const after = nextPoll.apps.find((app) => app.id === first.grantId)!;
        assert.ok(Date.parse(after.lastAuthorizedAt) > Date.parse(firstPoll.serverTime));
        assert.equal(after.connectedAt, before.connectedAt);
      });

      it("shows alreadyConnected only for this owner's live grant on this app and resource", async () => {
        const owner = await newOwner();
        const otherOwner = await newOwner();
        const app = await newCimdClient();
        const otherApp = await newCimdClient();
        const request = await startAuthorization(app);
        const view = async () => {
          const loaded = await loadConsentView({
            confirmation: confirmationOf(request.transaction),
            transactionCookie: request.transaction,
            formNonceCookie: request.formNonce,
            sessionCookie: owner.sessionToken,
          });
          assert.notEqual(loaded.step, "expired");
          return loaded as Exclude<typeof loaded, { step: "expired" }>;
        };

        assert.equal((await view()).alreadyConnected, false, "nothing connected yet");
        await connect(otherOwner, app);
        assert.equal((await view()).alreadyConnected, false, "another owner's grant");
        await connect(owner, otherApp);
        assert.equal((await view()).alreadyConnected, false, "this owner's grant on another app");
        await pool!.query(
          `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
         SELECT $1, $2, client.id, 'https://elsewhere.example.test/mcp', '{}'
         FROM exomem_oauth_clients AS client WHERE client.client_id = $3`,
          [owner.userId, owner.tenantId, app.clientId]
        );
        assert.equal((await view()).alreadyConnected, false, "a grant for another resource");
        const connection = await connect(owner, app);
        const connected = await view();
        assert.equal(connected.alreadyConnected, true, "this owner's live grant");
        assert.equal(connected.step, "connect");
        assert.equal(connected.app.displayName, "Claude");
        await disconnectRoute(...disconnectRequest(owner, connection.grantId));
        assert.equal((await view()).alreadyConnected, false, "a revoked grant");
      });

      describe("once clients carry a stored name and a first-party mode", () => {
        async function newPinnedClient(input: {
          redirectUri: string;
          clientName?: string;
        }): Promise<Client> {
          const clientId = `pinned-${randomUUID()}`;
          await pool!.query(
            `INSERT INTO exomem_oauth_clients (
               client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_name
             ) VALUES (
               $1, 'pinned', true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), $3
             )`,
            [clientId, JSON.stringify([input.redirectUri]), input.clientName ?? null]
          );
          return { clientId, redirectUri: input.redirectUri };
        }

        it("names each app by its stored name, else its platform, else its redirect host", async () => {
          const owner = await newOwner();
          const named = await newCimdClient("claude");
          await pool!.query(
            "UPDATE exomem_oauth_clients SET client_name = 'Example Notes' WHERE client_id = $1",
            [named.clientId]
          );
          const platformOnly = await newCimdClient("openai");
          const operatorNamed = await newPinnedClient({
            redirectUri: "https://cli.example.test/callback",
            clientName: "Example CLI",
          });
          const local = await newPinnedClient({ redirectUri: "http://127.0.0.1/callback" });
          const grants = {
            named: (await connect(owner, named)).grantId,
            platformOnly: (await connect(owner, platformOnly)).grantId,
            operatorNamed: (await connect(owner, operatorNamed)).grantId,
            local: (await connect(owner, local)).grantId,
          };

          const { apps } = await listOwnerApps(owner);

          assert.deepEqual(
            apps
              .map(({ id, displayName, displayNameSource, kind, context, redirectHosts }) => ({
                id,
                displayName,
                displayNameSource,
                kind,
                context,
                redirectHosts,
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
            [
              {
                id: grants.named,
                displayName: "Example Notes",
                displayNameSource: "client_metadata",
                kind: "web",
                context: "conversation",
                redirectHosts: [new URL(named.redirectUri).hostname],
              },
              {
                id: grants.platformOnly,
                displayName: "ChatGPT",
                displayNameSource: "platform",
                kind: "web",
                context: "conversation",
                redirectHosts: [new URL(platformOnly.redirectUri).hostname],
              },
              {
                id: grants.operatorNamed,
                displayName: "Example CLI",
                displayNameSource: "operator",
                kind: "web",
                context: "conversation",
                redirectHosts: ["cli.example.test"],
              },
              {
                id: grants.local,
                displayName: "127.0.0.1",
                displayNameSource: "redirect_host",
                kind: "local",
                context: "coding",
                redirectHosts: ["127.0.0.1"],
              },
            ].sort((a, b) => a.id.localeCompare(b.id))
          );
        });

        it("keeps Home's own client out of the list and out of disconnect", async () => {
          const owner = await newOwner();
          // Migration 0066 seeds the one first-party client. Home mints its
          // tokens on the server and never through a browser consent, so the
          // grant is written here the way that mint writes it.
          const homeGrant = await pool!.query<{ id: string; client_id: string }>(
            `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
             SELECT $1, $2, id, $3, ARRAY['exomem.read', 'exomem.write']
             FROM exomem_oauth_clients WHERE admission_mode = 'first_party'
             RETURNING id, client_id`,
            [owner.userId, owner.tenantId, CLOUD_RESOURCE]
          );
          const { id: grantId, client_id: homeClientId } = homeGrant.rows[0]!;
          const family = await pool!.query<{ id: string }>(
            `INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
             VALUES ($1, $2, now() + interval '30 days') RETURNING id`,
            [grantId, homeClientId]
          );
          const accessDigest = randomBytes(32);
          await pool!.query(
            `INSERT INTO exomem_oauth_access_tokens (
               access_digest, grant_id, family_id, client_id, resource, scopes, expires_at
             ) VALUES ($1, $2, $3, $4, $5, ARRAY['exomem.read', 'exomem.write'], now() + interval '2 minutes')`,
            [accessDigest, grantId, family.rows[0]!.id, homeClientId, CLOUD_RESOURCE]
          );
          const homeConnection = { grantId, accessDigest };

          const { apps } = await listOwnerApps(owner);
          const response = await disconnectRoute(
            ...disconnectRequest(owner, homeConnection.grantId)
          );

          assert.deepEqual(apps, []);
          assert.equal(response.status, 404);
          assert.ok(await findCloudOAuthAccessToken(homeConnection.accessDigest, CLOUD_RESOURCE));
        });

        // The release before this one shares these store statements. They admit
        // a client by a pinned or generic mode or by admitted CIMD metadata;
        // the seeded Home client has neither, and no supported writer adds
        // that metadata to it.
        it("refuses the first-party client at authorization, code exchange and refresh", async () => {
          const owner = await newOwner();
          const seeded = await pool!.query<{ id: string; client_id: string; redirect_uri: string }>(
            `SELECT id, client_id, redirect_uris ->> 0 AS redirect_uri
             FROM exomem_oauth_clients WHERE admission_mode = 'first_party'`
          );
          const {
            id: homeClientId,
            client_id: clientId,
            redirect_uri: redirectUri,
          } = seeded.rows[0]!;

          const started = await createOAuthContinuation({
            clientId,
            redirectUri,
            resource: CLOUD_RESOURCE,
            scopes: ["exomem.read", "exomem.write"],
            state: `state-${randomUUID()}`,
            codeChallenge: `challenge-${randomUUID()}`,
            offlineAccess: true,
          });
          assert.equal(started, null);

          // A code and a refresh token as a browser authorization would have
          // left them for this client.
          const codeDigest = randomBytes(32);
          const refreshDigest = randomBytes(32);
          const challenge = `challenge-${randomUUID()}`;
          await pool!.query(
            `WITH oauth_grant AS (
               INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed)
               VALUES ($1, $2, $3, $4, ARRAY['exomem.read', 'exomem.write'], true)
               RETURNING id
             ), code AS (
               INSERT INTO exomem_oauth_authorization_codes (
                 code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge,
                 refresh_allowed, expires_at
               )
               SELECT $5, id, $3, $6, $4, $7, true, now() + interval '5 minutes' FROM oauth_grant
             ), family AS (
               INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
               SELECT id, $3, now() + interval '30 days' FROM oauth_grant
               RETURNING id
             )
             INSERT INTO exomem_oauth_refresh_tokens (refresh_digest, family_id, expires_at)
             SELECT $8, id, now() + interval '1 day' FROM family`,
            [
              owner.userId,
              owner.tenantId,
              homeClientId,
              CLOUD_RESOURCE,
              codeDigest,
              redirectUri,
              challenge,
              refreshDigest,
            ]
          );

          const exchanged = await issueOAuthTokensFromCodeAtomic({
            codeDigest,
            clientId,
            redirectUri,
            resource: CLOUD_RESOURCE,
            pkceChallenge: challenge,
            refreshDigest: randomBytes(32),
            accessDigest: randomBytes(32),
            accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
          });
          assert.equal(exchanged, null);
          const refreshed = await rotateOAuthRefreshTokenAtomic({
            refreshDigest,
            replacementRefreshDigest: randomBytes(32),
            accessDigest: randomBytes(32),
            accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
            clientId,
            resource: CLOUD_RESOURCE,
          });
          assert.equal(refreshed, null);
        });

        // A client can declare any name, including another product's. The page
        // must be able to show where the code would really go.
        it("gives the consent page the redirect host of an app that names itself", async () => {
          // A metadata document on an admitted host can declare any client_name.
          const impostor = await newCimdClient("openai");
          await pool!.query(
            "UPDATE exomem_oauth_clients SET client_name = 'Claude' WHERE client_id = $1",
            [impostor.clientId]
          );
          const request = await startAuthorization(impostor);

          const view = await loadConsentView({
            confirmation: confirmationOf(request.transaction),
            transactionCookie: request.transaction,
            formNonceCookie: request.formNonce,
            sessionCookie: undefined,
          });

          assert.notEqual(view.step, "expired");
          assert.deepEqual((view as Exclude<typeof view, { step: "expired" }>).app, {
            displayName: "Claude",
            displayNameSource: "client_metadata",
            platform: "openai",
            loopback: false,
            redirectHost: new URL(impostor.redirectUri).hostname,
          });
        });
      });
    });
  }
);
