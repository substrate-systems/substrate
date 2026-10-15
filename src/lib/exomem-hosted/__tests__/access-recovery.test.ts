import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Pool } from "pg";
import type { NextRequest } from "next/server";
import { applyMigrations } from "../../../../scripts/migrate";
import { __setExomemSqlForTests, createMagicAccessToken, type ExomemSql } from "../db";
import type { SendTransactionalEmailInput, SendTransactionalEmailResult } from "@/lib/brevo";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { setOperationalEventSinkForTests } from "../observability";
import { EXOMEM_RATE_LIMITS, hashRateLimitKey } from "../rate-limit";
import { encryptSecret, tokenDigest } from "../security";
import { EXOMEM_ACCESS_RECOVERY_COOKIE, resolveExomemSession } from "../sessions";

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");
const originalKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const callbacks: Array<() => Promise<void>> = [];
let registrationFails = false;
let provider: (
  input: SendTransactionalEmailInput
) => Promise<SendTransactionalEmailResult> = async () => ({ success: true });
let resend: typeof import("@/app/api/exomem/access/magic-link/recover/route").POST;
let redeem: typeof import("@/app/api/exomem/access/magic-link/redeem/route").POST;
let start: typeof import("@/app/api/exomem/access/start/route").POST;
let magicLink: typeof start;
let recovery: typeof import("../access-recovery");
let drainMagicLinkDeliveries: typeof import("../access-delivery").drainMagicLinkDeliveries;
before(async () => {
  const nextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: {
      NextRequest: nextServer.NextRequest,
      NextResponse: nextServer.NextResponse,
      after: (callback: () => Promise<void>) => {
        if (registrationFails) throw new Error("request scope unavailable");
        callbacks.push(callback);
      },
    },
  });
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: (input: SendTransactionalEmailInput) => provider(input),
    },
  });
  mock.module("../turnstile", {
    namedExports: { verifyTurnstileToken: async () => "passed" },
  });
  ({ POST: resend } = await import("@/app/api/exomem/access/magic-link/recover/route"));
  ({ POST: redeem } = await import("@/app/api/exomem/access/magic-link/redeem/route"));
  ({ POST: start } = await import("@/app/api/exomem/access/start/route"));
  ({ POST: magicLink } = await import("@/app/api/exomem/access/magic-link/route"));
  recovery = await import("../access-recovery");
  ({ drainMagicLinkDeliveries } = await import("../access-delivery"));
  mock.method(globalThis, "fetch", async () => {
    throw new Error("external effects blocked");
  });
});
after(() => mock.reset());

function request(path: string, body: object, cookie?: string): NextRequest {
  return new Request(`https://app.example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.test",
      host: "app.example.test",
      "x-forwarded-for": "203.0.113.45",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

it("the opaque receipt has a distinct purpose, bounded expiry, and no authentication authority", async () => {
  const material = recovery.mintAccessRecoveryReceipt({
    email: "owner@example.test",
    timeZone: "Europe/London",
    challengeDigest: randomBytes(32),
    prior: null,
  });
  const cookie = `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${material.token}`;
  const input = request("/api/exomem/access/magic-link/recover", {}, cookie);
  assert.equal(material.ttl, 3600);
  assert.ok(material.token.length < 2048);
  assert.equal(material.token.includes("owner@example.test"), false);
  assert.equal(recovery.readAccessRecoveryReceipt(input)?.email, "owner@example.test");
  assert.equal(
    recovery.readAccessRecoveryReceipt(input, new Date(material.receipt.expiresAt)),
    null
  );
  await assert.rejects(resolveExomemSession(input), { code: "EXOMEM_SESSION_INVALID" });
  const wrongPurpose = Buffer.from(
    JSON.stringify(encryptSecret(JSON.stringify({ ...material.receipt, purpose: "session" })))
  ).toString("base64url");
  assert.equal(
    recovery.readAccessRecoveryReceipt(
      request(
        "/api/exomem/access/magic-link/recover",
        {},
        `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${wrongPurpose}`
      )
    ),
    null
  );
});

describe(
  "browser recovery through real access routes and PostgreSQL",
  { skip: !databaseUrl },
  () => {
    let pool: Pool;
    let schema: string;
    let sql: ExomemSql;
    before(async () => {
      schema = `access_recovery_${randomUUID().replaceAll("-", "")}`;
      await ensureExomemPostgresTestExtensions(databaseUrl!);
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      await applyMigrations({ databaseUrl: scoped.toString() });
      await admin.end();
      pool = new Pool({ connectionString: scoped.toString(), max: 3 });
      sql = async (strings, ...values) => {
        const query = strings.reduce(
          (text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""),
          ""
        );
        const result = await pool.query(query, values);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      };
      __setExomemSqlForTests(sql);
    });
    beforeEach(async () => {
      await pool.query("TRUNCATE users CASCADE");
      await pool.query("TRUNCATE exomem_rate_limit_buckets");
      callbacks.length = 0;
      registrationFails = false;
      provider = async () => ({ success: true });
      __setExomemSqlForTests(sql);
    });
    after(async () => {
      __setExomemSqlForTests(null);
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
      process.env.EXOMEM_CONTROL_PLANE_KEY = originalKey;
    });

    for (const path of [
      "/api/exomem/access/start",
      "/api/exomem/access/magic-link",
      "/api/exomem/access/magic-link/recover",
    ]) {
      it(`${path} returns the uniform response before sending its queued row`, async () => {
        const route = path.endsWith("/recover")
          ? resend
          : path.endsWith("/start")
            ? start
            : magicLink;
        const email = `${randomUUID()}@example.test`;
        const userId = randomUUID();
        await pool.query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, email]);
        await pool.query(
          "INSERT INTO exomem_tenants (owner_user_id,status,desired_state) VALUES ($1,'active','running')",
          [userId]
        );
        const backlogOwner = randomUUID();
        const backlogEmail = `${randomUUID()}@example.test`;
        await pool.query("INSERT INTO users (id,email) VALUES ($1,$2)", [
          backlogOwner,
          backlogEmail,
        ]);
        await pool.query(
          "INSERT INTO exomem_tenants (owner_user_id,status,desired_state) VALUES ($1,'active','running')",
          [backlogOwner]
        );
        const older = await createMagicAccessToken({
          emailNormalized: backlogEmail,
          tokenDigest: randomBytes(32),
          browserChallengeDigest: randomBytes(32),
          expiresAt: new Date(Date.now() + 900_000),
          deliverySecretCiphertext: encryptSecret("unrelated backlog"),
        });
        // The recovery route derives its recipient from its opaque receipt.
        const receipt = recovery.mintAccessRecoveryReceipt({
          email,
          timeZone: null,
          challengeDigest: randomBytes(32),
          prior: null,
        });
        let sends = 0;
        provider = async (input) => {
          sends += 1;
          assert.equal(input.to, email);
          return { success: true };
        };
        const started = performance.now();
        const response = await route(
          request(
            path,
            route === resend ? {} : { email },
            `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${receipt.token}`
          )
        );
        assert.equal(response.status, 202);
        assert.ok(performance.now() - started >= 600);
        assert.equal(sends, 0);
        const body = await response.json();
        assert.deepEqual(Object.keys(body).sort(), [
          "requestId",
          "retryAfterSeconds",
          "retryLimited",
          "status",
          "success",
        ]);
        assert.equal(body.status, "if_eligible_email_sent");
        assert.equal(response.cookies.get("exomem_session"), undefined);
        assert.equal(callbacks.length, 1);
        await callbacks[0]();
        assert.equal(sends, 1);
        const stored = await pool.query(
          "SELECT outbox.state, outbox.secret_ciphertext, token.delivery_state FROM exomem_access_delivery_outbox outbox JOIN exomem_access_tokens token ON token.id=outbox.token_id WHERE token.user_id=$1",
          [userId]
        );
        assert.deepEqual(stored.rows, [
          { state: "sent", secret_ciphertext: null, delivery_state: "sent" },
        ]);
        assert.ok(older);
        const untouched = await pool.query(
          "SELECT state, attempts FROM exomem_access_delivery_outbox WHERE id=$1",
          [older.deliveryId]
        );
        assert.deepEqual(untouched.rows, [{ state: "pending", attempts: 0 }]);
      });
    }

    for (const failure of ["provider", "registration", "callback"] as const) {
      it(`keeps a ${failure} failure recoverable by the scheduled sender after answering 202`, async () => {
        const userId = randomUUID();
        const email = "retry-owner@example.test";
        await pool.query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, email]);
        await pool.query(
          "INSERT INTO exomem_tenants (owner_user_id,status,desired_state) VALUES ($1,'active','running')",
          [userId]
        );
        registrationFails = failure === "registration";
        provider = async () => ({ success: false, error: "private-provider-detail" });
        const logs: string[] = [];
        setOperationalEventSinkForTests((line) => logs.push(line));
        try {
          const response = await start(request("/api/exomem/access/start", { email }));
          assert.equal(response.status, 202);
          if (failure === "callback") {
            __setExomemSqlForTests(async () => {
              throw new Error("private-database-detail");
            });
          }
          for (const callback of callbacks) await callback();
        } finally {
          __setExomemSqlForTests(sql);
          setOperationalEventSinkForTests(null);
        }
        assert.equal(logs.join(" ").includes("private-"), false);
        assert.equal(logs.join(" ").includes(email), false);
        if (failure !== "provider") {
          assert.ok(
            logs.some((line) => JSON.parse(line).event === "access.magic_link.delivery_failed")
          );
        }
        const pending = await pool.query(
          "SELECT state, attempts, secret_ciphertext IS NOT NULL AS encrypted FROM exomem_access_delivery_outbox"
        );
        assert.deepEqual(pending.rows, [
          { state: "pending", attempts: failure === "provider" ? 1 : 0, encrypted: true },
        ]);
        await pool.query("UPDATE exomem_access_delivery_outbox SET next_attempt_at=now()");
        provider = async (input) => {
          assert.equal(input.to, email);
          return { success: true };
        };
        const recovered = await drainMagicLinkDeliveries();
        assert.equal(recovered.sent, 1);
        const settled = await pool.query(
          "SELECT state, secret_ciphertext FROM exomem_access_delivery_outbox"
        );
        assert.deepEqual(settled.rows, [{ state: "sent", secret_ciphertext: null }]);
      });
    }

    it("after the authentication cookie clears, an expired link can resend only to its original address", async () => {
      const userId = randomUUID(),
        tenantId = randomUUID();
      const email = "expired-owner@example.test";
      await pool.query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, email]);
      await pool.query(
        "INSERT INTO exomem_tenants (id,owner_user_id,status,desired_state) VALUES ($1,$2,'active','running')",
        [tenantId, userId]
      );
      const token = randomBytes(32).toString("base64url");
      const challenge = randomBytes(32);
      await pool.query(
        "INSERT INTO exomem_access_tokens (purpose,token_digest,browser_challenge_digest,magic_link_generation,user_id,tenant_id,created_at,expires_at,delivery_state) VALUES ('magic_link',$1,$2,0,$3,$4,now()-interval '16 minutes',now()-interval '1 minute','sent')",
        [tokenDigest(token), challenge, userId, tenantId]
      );
      const receipt = recovery.mintAccessRecoveryReceipt({
        email,
        timeZone: "Europe/London",
        challengeDigest: challenge,
        prior: null,
      });
      const cookie = `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${receipt.token}`;
      // Before: the expired authentication cookie is absent, so the link cannot authenticate.
      const generic = await redeem(request("/api/exomem/access/magic-link/redeem", { token }));
      assert.equal((await generic.json()).error.code, "EMAIL_CONFIRMATION_REQUIRED");
      // After: the longer recovery cookie proves the binding, without granting a session.
      const expired = await redeem(
        request("/api/exomem/access/magic-link/redeem", { token }, cookie)
      );
      assert.equal((await expired.json()).error.code, "ACCESS_LINK_EXPIRED");
      assert.equal(expired.cookies.get("exomem_session"), undefined);
      const response = await resend(request("/api/exomem/access/magic-link/recover", {}, cookie));
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.status, "if_eligible_email_sent");
      assert.equal(body.retryAfterSeconds, 60);
      assert.equal(JSON.stringify(body).includes(email), false);
      const queued = await pool.query(
        "SELECT users.email::text, token.browser_challenge_digest FROM exomem_access_tokens AS token JOIN users ON users.id=token.user_id WHERE token.user_id=$1 AND token.expires_at>now()",
        [userId]
      );
      assert.equal(queued.rows.length, 1);
      assert.equal(queued.rows[0].email, email);
      const auth = response.cookies.get("exomem_magic_challenge")!.value;
      assert.ok(queued.rows[0].browser_challenge_digest.equals(tokenDigest(auth)!));
      assert.equal(response.cookies.get("exomem_session"), undefined);
      const sessionToken = randomBytes(32).toString("base64url");
      await pool.query(
        "INSERT INTO exomem_sessions (user_id,tenant_id,session_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 hour')",
        [userId, tenantId, tokenDigest(sessionToken), randomBytes(32)]
      );
      assert.equal(
        (
          await resolveExomemSession(
            request("/api/exomem/status", {}, `exomem_session=${sessionToken}`)
          )
        ).tenantId,
        tenantId
      );
      await assert.rejects(
        resolveExomemSession(request("/api/exomem/status", {}, `exomem_session=${receipt.token}`)),
        { code: "EXOMEM_SESSION_INVALID" }
      );
      const redirected = await resend(
        request(
          "/api/exomem/access/magic-link/recover",
          { email: "different@example.test" },
          cookie
        )
      );
      assert.equal(redirected.status, 400);
      const freshRecovery = response.cookies.get(EXOMEM_ACCESS_RECOVERY_COOKIE)!.value;
      const tooSoon = await resend(
        request(
          "/api/exomem/access/magic-link/recover",
          {},
          `exomem_magic_challenge=${auth}; ${EXOMEM_ACCESS_RECOVERY_COOKIE}=${freshRecovery}`
        )
      );
      assert.equal(tooSoon.status, 202);
      assert.equal((await tooSoon.json()).retryLimited, true);
      assert.equal(tooSoon.cookies.get("exomem_magic_challenge")!.value, auth);
      const held = recovery.readAccessRecoveryReceipt(
        request(
          "/api/exomem/access/magic-link/recover",
          {},
          `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${tooSoon.cookies.get(EXOMEM_ACCESS_RECOVERY_COOKIE)!.value}`
        )
      );
      assert.equal(held?.challengeDigest, tokenDigest(auth)!.toString("hex"));
      const activeTokens = await pool.query(
        "SELECT count(*)::int AS count FROM exomem_access_tokens WHERE user_id=$1 AND expires_at>now()",
        [userId]
      );
      assert.equal(activeTokens.rows[0].count, 1);
    });

    it("a used link is named only by its matching browser receipt", async () => {
      const userId = randomUUID(),
        tenantId = randomUUID();
      await pool.query("INSERT INTO users (id,email) VALUES ($1,'used-owner@example.test')", [
        userId,
      ]);
      await pool.query(
        "INSERT INTO exomem_tenants (id,owner_user_id,status,desired_state) VALUES ($1,$2,'active','running')",
        [tenantId, userId]
      );
      const token = randomBytes(32).toString("base64url"),
        challenge = randomBytes(32);
      await pool.query(
        "INSERT INTO exomem_access_tokens (purpose,token_digest,browser_challenge_digest,magic_link_generation,user_id,tenant_id,expires_at,delivery_state,consumed_at) VALUES ('magic_link',$1,$2,0,$3,$4,now()+interval '1 minute','sent',now())",
        [tokenDigest(token), challenge, userId, tenantId]
      );
      const bound = recovery.mintAccessRecoveryReceipt({
        email: "used-owner@example.test",
        timeZone: null,
        challengeDigest: challenge,
        prior: null,
      });
      const used = await redeem(
        request(
          "/api/exomem/access/magic-link/redeem",
          { token },
          `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${bound.token}`
        )
      );
      assert.equal((await used.json()).error.code, "ACCESS_LINK_USED");
      const another = recovery.mintAccessRecoveryReceipt({
        email: "another@example.test",
        timeZone: null,
        challengeDigest: randomBytes(32),
        prior: null,
      });
      const mismatched = await redeem(
        request(
          "/api/exomem/access/magic-link/redeem",
          { token },
          `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${another.token}`
        )
      );
      assert.equal((await mismatched.json()).error.code, "EMAIL_CONFIRMATION_REQUIRED");
      const crossBrowser = await redeem(request("/api/exomem/access/magic-link/redeem", { token }));
      assert.equal((await crossBrowser.json()).error.code, "EMAIL_CONFIRMATION_REQUIRED");
    });

    it("email suppression stays invisible while the common browser bucket supplies retry timing", async () => {
      const email = "suppressed@example.test";
      const rule = EXOMEM_RATE_LIMITS.startEmail;
      await pool.query(
        "INSERT INTO exomem_rate_limit_buckets (scope,key_digest,window_started_at,admitted_count,updated_at) VALUES ($1,$2,now(),$3,now())",
        [rule.scope, hashRateLimitKey(rule, email), rule.limit]
      );
      const receipt = recovery.mintAccessRecoveryReceipt({
        email,
        timeZone: null,
        challengeDigest: randomBytes(32),
        prior: null,
      });
      const started = performance.now();
      const suppressed = await resend(
        request(
          "/api/exomem/access/magic-link/recover",
          {},
          `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${receipt.token}`
        )
      );
      assert.ok(performance.now() - started >= 600);
      assert.equal(suppressed.status, 202);
      const hidden = await suppressed.json();
      assert.equal(hidden.status, "if_eligible_email_sent");
      assert.equal(hidden.retryAfterSeconds, 60);
      assert.equal(
        await recovery.accessStartRetryAfterSeconds(receipt.receipt.browserKey, "203.0.113.45"),
        60
      );
      const anonymous = await resend(request("/api/exomem/access/magic-link/recover", {}));
      const publicBody = await anonymous.json();
      assert.equal(anonymous.status, 202);
      assert.deepEqual(
        { ...hidden, requestId: undefined },
        { ...publicBody, requestId: undefined }
      );
      for (const name of ["exomem_magic_challenge", EXOMEM_ACCESS_RECOVERY_COOKIE]) {
        const a = suppressed.cookies.get(name)!,
          b = anonymous.cookies.get(name)!;
        assert.equal(a.httpOnly, b.httpOnly);
        assert.equal(a.sameSite, b.sameSite);
        assert.equal(a.maxAge, b.maxAge);
        assert.equal(a.path, b.path);
      }
      const outbox = await pool.query(
        "SELECT count(*)::int AS count FROM exomem_access_delivery_outbox JOIN exomem_access_tokens ON token_id=exomem_access_tokens.id JOIN users ON users.id=user_id WHERE users.email=$1",
        [email]
      );
      assert.equal(outbox.rows[0].count, 0);
    });
  }
);
