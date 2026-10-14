import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import type { NextRequest } from "next/server";
import { applyMigrations } from "../../../../scripts/migrate";
import { POST as redeem } from "@/app/api/exomem/access/magic-link/redeem/route";
import { POST as resend } from "@/app/api/exomem/access/magic-link/recover/route";
import {
  accessStartRetryAfterSeconds,
  mintAccessRecoveryReceipt,
  readAccessRecoveryReceipt,
} from "../access-recovery";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { EXOMEM_RATE_LIMITS, hashRateLimitKey } from "../rate-limit";
import { encryptSecret, tokenDigest } from "../security";
import { EXOMEM_ACCESS_RECOVERY_COOKIE, resolveExomemSession } from "../sessions";

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");
const originalKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;

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
  const material = mintAccessRecoveryReceipt({
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
  assert.equal(readAccessRecoveryReceipt(input)?.email, "owner@example.test");
  assert.equal(readAccessRecoveryReceipt(input, new Date(material.receipt.expiresAt)), null);
  await assert.rejects(resolveExomemSession(input), { code: "EXOMEM_SESSION_INVALID" });
  const wrongPurpose = Buffer.from(
    JSON.stringify(encryptSecret(JSON.stringify({ ...material.receipt, purpose: "session" })))
  ).toString("base64url");
  assert.equal(
    readAccessRecoveryReceipt(
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
    before(async () => {
      schema = `access_recovery_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      await applyMigrations({ databaseUrl: scoped.toString() });
      await admin.end();
      pool = new Pool({ connectionString: scoped.toString() });
      const sql: ExomemSql = async (strings, ...values) => {
        const query = strings.reduce(
          (text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""),
          ""
        );
        const result = await pool.query(query, values);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      };
      __setExomemSqlForTests(sql);
    });
    after(async () => {
      __setExomemSqlForTests(null);
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
      process.env.EXOMEM_CONTROL_PLANE_KEY = originalKey;
    });

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
      const recovery = mintAccessRecoveryReceipt({
        email,
        timeZone: "Europe/London",
        challengeDigest: challenge,
        prior: null,
      });
      const cookie = `${EXOMEM_ACCESS_RECOVERY_COOKIE}=${recovery.token}`;
      // Before: the expired authentication cookie is absent, so the link cannot authenticate.
      const generic = await redeem(request("/api/exomem/access/magic-link/redeem", { token }));
      assert.equal((await generic.json()).error.code, "ACCESS_TOKEN_INVALID");
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
        resolveExomemSession(request("/api/exomem/status", {}, `exomem_session=${recovery.token}`)),
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
      const held = readAccessRecoveryReceipt(
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
      const bound = mintAccessRecoveryReceipt({
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
      const another = mintAccessRecoveryReceipt({
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
      assert.equal((await mismatched.json()).error.code, "ACCESS_TOKEN_INVALID");
      const crossBrowser = await redeem(request("/api/exomem/access/magic-link/redeem", { token }));
      assert.equal((await crossBrowser.json()).error.code, "ACCESS_TOKEN_INVALID");
    });

    it("email suppression stays invisible while the common browser bucket supplies retry timing", async () => {
      const email = "suppressed@example.test";
      const rule = EXOMEM_RATE_LIMITS.startEmail;
      await pool.query(
        "INSERT INTO exomem_rate_limit_buckets (scope,key_digest,window_started_at,admitted_count,updated_at) VALUES ($1,$2,now(),$3,now())",
        [rule.scope, hashRateLimitKey(rule, email), rule.limit]
      );
      const receipt = mintAccessRecoveryReceipt({
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
        await accessStartRetryAfterSeconds(receipt.receipt.browserKey, "203.0.113.45"),
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
