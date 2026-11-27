import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { applyMigrations } from "../../../../../scripts/migrate";
import * as unsubscribeRoute from "../../../../app/api/exomem/unsubscribe/monthly-update/route";
import { PUT as homeSettingPut } from "../../../../app/api/exomem/account/monthly-update-email/route";
import { POST as operatorTurnOnPost } from "../../../../app/api/exomem/admin/monthly-update-email/route";
import { loadExomemAccountView } from "../../account-view";
import { executeExomemSql } from "../../db";
import { drainExomemEmailOutbox, enqueueExomemEmail } from "../../email-outbox";
import { CANARY_EMAIL_KINDS } from "../../health-canary";
import { ensureExomemPostgresTestExtensions } from "../../__tests__/postgres-test-extensions";
import { applyDigestAction } from "../approval";
import { decideMonth } from "../months";
import { fanOutWhatsNewDigestEmails, WHATS_NEW_DIGEST_FANOUT_BATCH } from "../fan-out";
import { previousMonth, runWhatsNewDigestSelection } from "../run";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../unsubscribe";
import { openIsolatedSchema } from "./db-harness";
import {
  notesFile,
  startBrevo,
  startGitHub,
  startModel,
  type BrevoMessage,
  type BrevoStandIn,
  type GitHubStandIn,
  type ModelStandIn,
} from "./stand-ins";

// The monthly digest's sending half against real PostgreSQL, a stand-in GitHub server, a stand-in
// model endpoint and a stand-in Brevo over HTTP. The month is built by the daily route and
// approved through the operator's actions, so the sender reads a record the selection half
// wrote, and Brevo's stand-in keeps the request the sender actually posted.

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");
const ADMIN_TOKEN = randomBytes(32).toString("base64url");
const BREVO_KEY = "brevo-stand-in-key";
const UNSUBSCRIBE_KEY = randomBytes(32).toString("base64url");
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;

const ENV_KEYS = [
  "EXOMEM_ADMIN_TOKEN",
  "EXOMEM_PUBLIC_BASE_URL",
  "EXOMEM_WHATS_NEW_GITHUB_API_URL",
  "EXOMEM_WHATS_NEW_FIRST_MONTH",
  "EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "BREVO_API_KEY",
  "BREVO_API_BASE_URL",
  "BREVO_SENDER_EMAIL",
  "NODE_ENV",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const env = process.env as Record<string, string | undefined>;

const note = (title: string | null, text: string) => ({ title, text });
const id = (version: string, position: number) => ({ version, position });

/** A UUID that sorts where the test wants it: bulk owners first, the special ones last. */
const bulkId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const specialId = (n: number) => `ffffffff-0000-4000-8000-${String(n).padStart(12, "0")}`;

const imageOf = (tag: string | null) =>
  `registry.example/evermatter@sha256:${createHash("sha256").update(String(tag)).digest("hex")}`;

describe(
  "the monthly digest, from an approved month to the mail provider",
  { skip: !databaseUrl },
  () => {
    let github: GitHubStandIn;
    let model: ModelStandIn;
    let brevo: BrevoStandIn;
    let database: Awaited<ReturnType<typeof openIsolatedSchema>>;
    let versionCounter = 0;

    const query = (text: string, params: unknown[] = []) => database.pool.query(text, params);

    /** Publishes a release of `month` with these notes; returns its version. */
    function publish(month: string, version: string, notes: ReturnType<typeof note>[]): string {
      const stamp = `${month}-15T12:00:00.000Z`;
      github.releases.push({
        version,
        createdAt: stamp,
        publishedAt: stamp,
        file: notesFile(version, stamp.slice(0, 10), notes),
      });
      return version;
    }

    const nextMonth = (month: string) => {
      const [year, number] = month.split("-").map(Number);
      return new Date(Date.UTC(year, number, 2, 6)); // the 2nd, 06:00 UTC, of the month after
    };
    const monthAfter = (month: string) => nextMonth(month).toISOString().slice(0, 7);

    /** The month through the daily route, the operator's blind pick and an approval of the model's ranking. */
    async function approvedMonth(month: string, ranking: ReturnType<typeof id>[]) {
      model.answers.push({ picks: ranking });
      await runWhatsNewDigestSelection({ now: nextMonth(month), retryDelayMs: 0 });
      await applyDigestAction({ action: "blind_pick", month, selection: ranking });
      await applyDigestAction({ action: "approve", month });
    }

    /** Three notes in a fresh release of `month`: enough for a digest of its own. */
    function threeNotesOf(month: string) {
      versionCounter += 1;
      const version = publish(month, `3.${versionCounter}.0`, [
        note("One", "First change."),
        note(null, "Second change."),
        note("Three", "Third change."),
      ]);
      return [id(version, 0), id(version, 1), id(version, 2)];
    }

    const randomCellId = () => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      return Array.from(randomBytes(16), (byte) => alphabet[byte % 32]).join("");
    };

    type OwnerOptions = {
      tenantId?: string;
      /** The cell's running release tag; `null` is an image that records none, `"none"` no image at all. */
      release?: string | null | "none";
      desired?: "running" | "stopped" | "deleted";
      observed?: "running" | "stopping" | "stopped";
      ready?: boolean;
      digest?: boolean;
      reviewer?: boolean;
      status?: "active" | "deletion_pending";
    };

    /** One owner with an address and a cell, as cellctl and the lifecycle leave them. */
    async function seedOwner(options: OwnerOptions = {}) {
      const release = options.release === undefined ? "v1.10.0" : options.release;
      const email = `owner-${randomUUID()}@example.test`;
      const user = await query("INSERT INTO exomem_users (email) VALUES ($1) RETURNING id", [
        email,
      ]);
      const tenant = await query(
        `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state, marketplace_reviewer_purpose, whats_new_digest)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, 'running', $4, $5) RETURNING id`,
        [
          options.tenantId ?? null,
          user.rows[0].id,
          options.status ?? "active",
          options.reviewer ?? false,
          options.digest ?? true,
        ]
      );
      let image: string | null = null;
      if (release !== "none") {
        image = imageOf(release);
        await query(
          "INSERT INTO exomem_cloud_image_history (image, release_tag) VALUES ($1, $2) ON CONFLICT (image) DO NOTHING",
          [image, release]
        );
      }
      await query(
        `INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, observed_state, ready, observed_image, hold_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomCellId(),
          tenant.rows[0].id,
          options.desired ?? "running",
          options.observed ?? "running",
          options.ready ?? true,
          image,
          options.observed === "stopping" ? "backup" : null,
        ]
      );
      return { email, tenantId: String(tenant.rows[0].id) };
    }

    const setting = async (tenantId: string) =>
      (await query("SELECT whats_new_digest FROM exomem_tenants WHERE id = $1", [tenantId])).rows[0]
        .whats_new_digest as boolean;

    const outboxOf = async (kind: string) =>
      (
        await query(
          "SELECT dedupe_key, state, last_error_code, tenant_id::text AS tenant_id FROM exomem_email_outbox WHERE kind = $1 ORDER BY dedupe_key",
          [kind]
        )
      ).rows as Array<{
        dedupe_key: string;
        state: string;
        last_error_code: string | null;
        tenant_id: string;
      }>;

    /** Drains the outbox, `maxMessages` at a time, until nothing is ready to claim. */
    async function drainAll() {
      for (let tick = 0; tick < 60; tick += 1) {
        const result = await drainExomemEmailOutbox({ maxMessages: 20, timeBudgetMs: 30_000 });
        if (result.claimed === 0) return;
      }
      throw new Error("the outbox did not settle");
    }

    const toOf = (message: BrevoMessage) => message.to[0]!.email;
    const unsubscribeAddressOf = (message: BrevoMessage) =>
      /^<(.+)>$/.exec(message.headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";

    // Month one is the previous month on the real clock; the later months follow it.
    const month1 = previousMonth(new Date());
    const month2 = monthAfter(month1);
    const month3 = monthAfter(month2);

    // The ranked selection of month one: version 1.10.0 is newer than 1.9.2, which only a numeric
    // comparison of the three parts knows.
    const ranking1 = [
      id("1.10.0", 0),
      id("1.9.2", 0),
      id("1.9.0", 0),
      id("1.2.0", 0),
      id("1.10.0", 1),
    ];

    const bulk = WHATS_NEW_DIGEST_FANOUT_BATCH + 5;
    const owners: Record<string, { email: string; tenantId: string }> = {};
    const bulkOwners: Array<{ email: string; tenantId: string }> = [];

    before(async () => {
      github = await startGitHub([]);
      model = await startModel();
      brevo = await startBrevo(BREVO_KEY);
      env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
      env.EXOMEM_PUBLIC_BASE_URL = "https://substratesystems.io";
      env.EXOMEM_WHATS_NEW_GITHUB_API_URL = github.origin;
      env.EXOMEM_WHATS_NEW_FIRST_MONTH = "2000-01";
      env.EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY = UNSUBSCRIBE_KEY;
      env.ANTHROPIC_BASE_URL = model.origin;
      env.ANTHROPIC_API_KEY = "test-key";
      env.BREVO_API_KEY = BREVO_KEY;
      env.BREVO_API_BASE_URL = `${brevo.origin}/v3`;
      env.BREVO_SENDER_EMAIL = "evermatter@example.test";
      // The sender returns without a request under NODE_ENV=test; this suite is about the request.
      env.NODE_ENV = "production";
      database = await openIsolatedSchema("whats_new_sending", databaseUrl!);

      publish(month1, "1.10.0", [note("T10A", "Ten A."), note("T10B", "Ten B.")]);
      publish(month1, "1.9.2", [note("T92", "Nine two.")]);
      publish(month1, "1.9.0", [note("T90", "Nine zero.")]);
      publish(month1, "1.2.0", [note("T12", "One two.")]);
      await approvedMonth(month1, ranking1);

      for (let n = 1; n <= bulk; n += 1) {
        bulkOwners.push(await seedOwner({ tenantId: bulkId(n) }));
      }
      // Owners that the digest reaches with their own notes, and those that it must pass over.
      owners.newest = await seedOwner({ tenantId: specialId(1), release: "v1.10.0" });
      owners.lagging = await seedOwner({ tenantId: specialId(2), release: "v1.9.2" });
      owners.fewerThanThree = await seedOwner({ tenantId: specialId(3), release: "v1.9.0" });
      owners.unknownRelease = await seedOwner({ tenantId: specialId(4), release: null });
      owners.noImage = await seedOwner({ tenantId: specialId(5), release: "none" });
      owners.stopped = await seedOwner({
        tenantId: specialId(6),
        desired: "stopped",
        observed: "stopped",
        ready: false,
      });
      owners.paused = await seedOwner({
        tenantId: specialId(7),
        observed: "stopping",
        ready: false,
      });
      owners.deleted = await seedOwner({
        tenantId: specialId(8),
        desired: "deleted",
        observed: "stopped",
        ready: false,
      });
      owners.settingOff = await seedOwner({ tenantId: specialId(9), digest: false });
      owners.reviewer = await seedOwner({ tenantId: specialId(10), reviewer: true });
      owners.deleting = await seedOwner({ tenantId: specialId(11), status: "deletion_pending" });
    });

    after(async () => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete env[key];
        else env[key] = savedEnv[key];
      }
      await database?.close();
      await github?.close();
      await model?.close();
      await brevo?.close();
    });

    it("queues 200 owners a tick with the dedupe key, then marks the month queued when none is left", async () => {
      const month = async () =>
        (
          await query(
            "SELECT state, queued_count, queue_cursor::text AS cursor FROM exomem_whats_new_digest_months WHERE month = $1",
            [month1]
          )
        ).rows[0];
      assert.equal((await month()).state, "ready_to_queue");

      // The delivery job's own tick, claiming one row, so the passes are the only thing that moves.
      const first = await drainExomemEmailOutbox({ maxMessages: 1 });
      assert.equal(first.whatsNewDigestEnqueued, WHATS_NEW_DIGEST_FANOUT_BATCH);
      assert.deepEqual(
        [(await month()).state, (await month()).cursor],
        ["ready_to_queue", bulkId(WHATS_NEW_DIGEST_FANOUT_BATCH)]
      );

      // The rest of the owners: five bulk ones, the newest cell and the lagging one. The other
      // three that the SQL reads (fewer than 3 notes, unknown release, no image) get no row.
      const second = await drainExomemEmailOutbox({ maxMessages: 1 });
      assert.equal(second.whatsNewDigestEnqueued, 5 + 2);
      assert.deepEqual([(await month()).state, (await month()).queued_count], ["queued", 207]);

      const third = await drainExomemEmailOutbox({ maxMessages: 1 });
      assert.equal(third.whatsNewDigestEnqueued, 0);

      const rows = await outboxOf("whats_new_digest");
      assert.equal(rows.length, 207);
      assert.ok(
        rows.every((row) => row.dedupe_key === `whats-new-digest:${month1}:${row.tenant_id}`),
        "each row is keyed by the month and its tenant"
      );
      const queuedTenants = new Set(rows.map((row) => row.tenant_id));
      for (const name of ["newest", "lagging"])
        assert.ok(queuedTenants.has(owners[name]!.tenantId));
      for (const name of [
        "fewerThanThree",
        "unknownRelease",
        "noImage",
        "stopped",
        "paused",
        "deleted",
        "settingOff",
        "reviewer",
        "deleting",
      ]) {
        assert.ok(!queuedTenants.has(owners[name]!.tenantId), `${name} gets no digest`);
      }

      // A queued month is not scanned again: an owner who becomes eligible now waits for next month.
      const late = await seedOwner({ tenantId: bulkId(900) });
      const afterQueued = await drainExomemEmailOutbox({ maxMessages: 1 });
      assert.equal(afterQueued.whatsNewDigestEnqueued, 0);
      assert.ok(
        !(await outboxOf("whats_new_digest")).some((row) => row.tenant_id === late.tenantId)
      );
      await query("UPDATE exomem_tenants SET whats_new_digest = false WHERE id = $1", [
        late.tenantId,
      ]);
    });

    it("claims a digest only after every other queued kind, the health canary's included, and sends both headers", async () => {
      // Everything below is newer than the digests already queued, and still goes first.
      const payer = await seedOwner({ release: "none", desired: "stopped", observed: "stopped" });
      const graceStartedAt = new Date().toISOString();
      await query(
        `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state, provider_environment,
         provider_subscription_ref, source_occurred_at, source_revision, grace_started_at
       ) VALUES ($1, 'paddle', 'past_due', 'active', 'sandbox', $2, now(), 'evt_past_due', $3)`,
        [payer.tenantId, `sub_${randomUUID().replaceAll("-", "")}`, graceStartedAt]
      );
      await enqueueExomemEmail(executeExomemSql, {
        kind: "payment_failed",
        dedupeKey: `test:payment-failed:${payer.tenantId}`,
        recipient: payer.email,
        recipientTimeZone: null,
        recipientEmailScheme: null,
        tenantId: payer.tenantId,
        payload: { version: 1, tenantId: payer.tenantId, graceStartedAt },
      });
      const canaryAddresses: string[] = [];
      for (const kind of CANARY_EMAIL_KINDS) {
        const address = `canary-${kind}@example.test`;
        canaryAddresses.push(address);
        const entry = await query(
          "INSERT INTO exomem_waitlist_entries (email_normalized) VALUES ($1) RETURNING id",
          [address]
        );
        await enqueueExomemEmail(executeExomemSql, {
          kind,
          dedupeKey: `test:${kind}:${entry.rows[0].id}`,
          recipient: address,
          recipientTimeZone: null,
          recipientEmailScheme: null,
          payload: { version: 1, entryId: String(entry.rows[0].id) },
        });
      }

      // The tier is set at insert from the kind's definition: the claim's index reads it.
      const tiers = new Map(
        (
          await query(
            "SELECT kind, min(send_tier)::int AS lowest, max(send_tier)::int AS highest FROM exomem_email_outbox WHERE state = 'pending' GROUP BY kind"
          )
        ).rows.map((row) => [row.kind, [row.lowest, row.highest]])
      );
      assert.deepEqual(tiers.get("payment_failed"), [0, 0]);
      for (const kind of CANARY_EMAIL_KINDS) assert.deepEqual(tiers.get(kind), [1, 1]);
      assert.deepEqual(tiers.get("whats_new_digest"), [2, 2]);

      const sentBefore = brevo.sent.length;
      await drainAll();

      // Four digests went out while the first test counted passes; the rest are in this drain.
      const order = brevo.sent.slice(sentBefore).map(toOf);
      const otherKinds = new Set([payer.email, ...canaryAddresses]);
      const lastOther = Math.max(...[...otherKinds].map((address) => order.indexOf(address)));
      const firstDigest = order.findIndex((address) => !otherKinds.has(address));
      assert.deepEqual(
        [...otherKinds].map((address) => order.includes(address)),
        [true, true, true]
      );
      assert.ok(
        lastOther < firstDigest,
        `a digest went out at ${firstDigest}, before another kind at ${lastOther}`
      );
      // The payment email, in the first tier, goes before the canary's waitlist emails.
      assert.equal(order[0], payer.email);

      const digests = brevo.sent.filter((message) => !otherKinds.has(toOf(message)));
      assert.equal(digests.length, 207, "every queued digest, once");
      for (const message of digests) {
        assert.equal(message.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
        assert.match(
          message.headers?.["List-Unsubscribe"] ?? "",
          /^<https:\/\/substratesystems\.io\/api\/exomem\/unsubscribe\/monthly-update\?token=[\w.-]+>$/
        );
      }
      // The mail of any other kind carries no such header.
      const payment = brevo.sent.find((message) => toOf(message) === payer.email);
      assert.equal(payment?.headers, undefined);
    });

    it("gives each owner the selected notes that their cell runs, comparing versions as numbers", async () => {
      const sentTo = (owner: { email: string }) =>
        brevo.sent.find((message) => toOf(message) === owner.email);

      const newest = sentTo(owners.newest!);
      assert.ok(newest);
      // The ranked order of the selection, each note as its title then its sentence.
      const titles = ["T10A", "T92", "T90", "T12", "T10B"];
      const positions = titles.map((title) => newest.textContent.indexOf(title));
      assert.ok(positions.every((at) => at >= 0));
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        positions
      );
      assert.ok(
        newest.textContent.includes("https://github.com/substrate-systems/evermatter/releases")
      );
      assert.equal(newest.subject, `What's new in Evermatter, ${monthName(month1)}`);
      // The body's link opens the page, with the token in the fragment.
      assert.match(
        newest.htmlContent,
        /href="https:\/\/substratesystems\.io\/exomem\/unsubscribe\/monthly-update#[\w.-]+"/
      );

      // 1.9.2 is below 1.10.0: this cell runs 1.9.2, so it keeps three notes and none from 1.10.0.
      const lagging = sentTo(owners.lagging!);
      assert.ok(lagging);
      for (const title of ["T92", "T90", "T12"]) assert.ok(lagging.textContent.includes(title));
      for (const title of ["T10A", "T10B"]) assert.ok(!lagging.textContent.includes(title));

      for (const name of [
        "fewerThanThree",
        "unknownRelease",
        "noImage",
        "stopped",
        "paused",
        "deleted",
      ]) {
        assert.equal(sentTo(owners[name]!), undefined, `${name} gets no email`);
      }
      // Each token names the tenant of the address that received it.
      const tenantOfNewest = verifyUnsubscribeToken(
        new URL(unsubscribeAddressOf(newest)).searchParams.get("token")!
      );
      assert.equal(tenantOfNewest, owners.newest!.tenantId);
    });

    it("turns the setting off on a one-click POST, and a token that is not ours changes nothing", async () => {
      const message = brevo.sent.find((m) => toOf(m) === owners.newest!.email)!;
      const address = unsubscribeAddressOf(message);
      const post = (url: string) =>
        unsubscribeRoute.POST(
          new NextRequest(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
          })
        );

      assert.equal(await setting(owners.newest!.tenantId), true);
      // Not ours: a bare tenant id, a token from another key, and the genuine one with its MAC cut.
      const foreign = signUnsubscribeToken(owners.newest!.tenantId, randomBytes(32));
      for (const token of [
        owners.newest!.tenantId,
        foreign,
        address.split("token=")[1]!.slice(0, -2),
      ]) {
        const refused = await post(
          `https://substratesystems.io/api/exomem/unsubscribe/monthly-update?token=${token}`
        );
        assert.equal(refused.status, 401);
      }
      assert.equal(await setting(owners.newest!.tenantId), true);

      const accepted = await post(address);
      assert.equal(accepted.status, 200);
      assert.equal(await setting(owners.newest!.tenantId), false);
      // The same POST again is safe, and another owner is untouched.
      assert.equal((await post(address)).status, 200);
      assert.equal(await setting(owners.lagging!.tenantId), true);

      // A link scanner's GET has no handler: the route exports only POST, so Next answers 405.
      assert.deepEqual(
        Object.keys(unsubscribeRoute).filter((name) => /^(GET|HEAD|PUT|PATCH|DELETE)$/.test(name)),
        []
      );

      // Home reads the value that the link last set, and a reviewer account has none.
      assert.deepEqual((await homeAccount(owners.newest!)).monthlyUpdateEmail, {
        enabled: false,
        invited: false,
      });
      assert.equal((await homeAccount(owners.lagging!, true)).monthlyUpdateEmail, null);
    });

    it("re-checks at send time: setting off, cell stopped, release rolled back, and a skipped month", async () => {
      publish(month2, "2.0.0", [note("N1", "Newest one."), note("N2", "Newest two.")]);
      publish(month2, "1.99.0", [note("O1", "Older one.")]);
      const ranking2 = [id("2.0.0", 0), id("2.0.0", 1), id("1.99.0", 0)];
      await approvedMonth(month2, ranking2);

      const keeps = await seedOwner({ tenantId: bulkId(1001), release: "v2.0.0" });
      const optsOut = await seedOwner({ tenantId: bulkId(1002), release: "v2.0.0" });
      const stopsLater = await seedOwner({ tenantId: bulkId(1003), release: "v2.0.0" });
      const rolledBack = await seedOwner({ tenantId: bulkId(1004), release: "v2.0.0" });
      // Turn off every other owner that is still on, so the pass queues only these four.
      await query(
        "UPDATE exomem_tenants SET whats_new_digest = false WHERE whats_new_digest AND id <> ALL($1::uuid[])",
        [[keeps, optsOut, stopsLater, rolledBack].map((owner) => owner.tenantId)]
      );
      const before = brevo.sent.length;

      const queued = await fanOutWhatsNewDigestEmails();
      assert.equal(queued.enqueued, 4);

      await post(unsubscribeAddressFor(optsOut.tenantId));
      await query(
        "UPDATE exomem_cloud_cells SET desired_state = 'stopped', observed_state = 'stopped', ready = false WHERE tenant_id = $1",
        [stopsLater.tenantId]
      );
      // The owner's cell now runs an older image: only one of the month's notes is at or below it.
      const older = imageOf("v1.99.0");
      await query(
        "INSERT INTO exomem_cloud_image_history (image, release_tag) VALUES ($1, 'v1.99.0') ON CONFLICT DO NOTHING",
        [older]
      );
      await query("UPDATE exomem_cloud_cells SET observed_image = $1 WHERE tenant_id = $2", [
        older,
        rolledBack.tenantId,
      ]);

      await drainAll();

      const sent = brevo.sent.slice(before).map(toOf);
      assert.deepEqual(sent, [keeps.email]);
      const settled = new Map(
        (await outboxOf("whats_new_digest"))
          .filter((row) => row.dedupe_key.startsWith(`whats-new-digest:${month2}:`))
          .map((row) => [row.tenant_id, row])
      );
      assert.equal(settled.get(keeps.tenantId)?.state, "sent");
      for (const owner of [optsOut, stopsLater, rolledBack]) {
        assert.deepEqual(
          [settled.get(owner.tenantId)?.state, settled.get(owner.tenantId)?.last_error_code],
          ["cancelled", "EMAIL_PRECONDITION_GONE"]
        );
      }

      // A month the operator stops sends nothing, even where its rows are queued and the month is already marked queued.
      const ranking3 = threeNotesOf(month3);
      await approvedMonth(month3, ranking3);
      const waiting = await seedOwner({ tenantId: bulkId(1101), release: "v3.999.0" });
      await query(
        "UPDATE exomem_tenants SET whats_new_digest = false WHERE id <> $1 AND whats_new_digest",
        [waiting.tenantId]
      );
      assert.equal((await fanOutWhatsNewDigestEmails()).enqueued, 1);
      assert.equal(
        (await query("SELECT state FROM exomem_whats_new_digest_months WHERE month = $1", [month3]))
          .rows[0].state,
        "queued"
      );
      const stopped = await applyDigestAction({ action: "stop", month: month3 });
      assert.equal((stopped as { state: string }).state, "skipped");
      const beforeSkip = brevo.sent.length;
      await drainAll();
      assert.equal(brevo.sent.length, beforeSkip);
      assert.equal(
        (await outboxOf("whats_new_digest")).find((row) => row.tenant_id === waiting.tenantId)
          ?.state,
        "cancelled"
      );
    });

    function unsubscribeAddressFor(tenantId: string) {
      return `https://substratesystems.io/api/exomem/unsubscribe/monthly-update?token=${signUnsubscribeToken(tenantId)}`;
    }

    function post(url: string) {
      return unsubscribeRoute.POST(
        new NextRequest(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        })
      );
    }

    const monthName = (month: string) =>
      new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(
        new Date(`${month}-01T00:00:00Z`)
      );

    /** Home's account read for the owner, through the real loader; `reviewer` reads it as a reviewer session. */
    async function homeAccount(owner: { tenantId: string }, reviewer = false) {
      await query(
        `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state, source_occurred_at, source_revision)
       VALUES ($1, 'complimentary', 'complimentary_active', 'active', now(), 'evt_initial')
       ON CONFLICT (tenant_id) DO NOTHING`,
        [owner.tenantId]
      );
      const userId = String(
        (await query("SELECT owner_user_id FROM exomem_tenants WHERE id = $1", [owner.tenantId]))
          .rows[0].owner_user_id
      );
      return loadExomemAccountView(
        { userId, tenantId: owner.tenantId, reviewerCredentialId: reviewer ? randomUUID() : null },
        { environment: {} }
      );
    }

    it("queues nothing before a month's send time, then queues it, so the operator's stop window holds", async () => {
      const month = "2039-05";
      const ranking = threeNotesOf(month);
      model.answers.push({ picks: ranking });
      await runWhatsNewDigestSelection({ now: nextMonth(month), retryDelayMs: 0 });
      // The month goes out on the standing switch: a day's window before the fan-out starts.
      await decideMonth(month, "automatic", ranking, new Date(Date.now() + 24 * 3_600_000));
      const waiting = await seedOwner({ tenantId: bulkId(1201), release: "v3.999.0" });
      await query(
        "UPDATE exomem_tenants SET whats_new_digest = false WHERE id <> $1 AND whats_new_digest",
        [waiting.tenantId]
      );
      assert.equal((await fanOutWhatsNewDigestEmails()).enqueued, 0);
      const state = async () =>
        (
          await query(
            "SELECT state, queued_count FROM exomem_whats_new_digest_months WHERE month = $1",
            [month]
          )
        ).rows[0];
      assert.deepEqual(await state(), { state: "ready_to_queue", queued_count: 0 });

      // The window passes.
      await query(
        "UPDATE exomem_whats_new_digest_months SET send_after = now() - interval '1 second' WHERE month = $1",
        [month]
      );
      assert.equal((await fanOutWhatsNewDigestEmails()).enqueued, 1);
      assert.equal((await state()).state, "queued");
      await applyDigestAction({ action: "stop", month });
    });

    describe("the owner's setting", () => {
      it("is settled by Home and by the operator under one rule for the invitation", async () => {
        const ownerOf = async (tenantId: string) =>
          String(
            (await query("SELECT owner_user_id FROM exomem_tenants WHERE id = $1", [tenantId]))
              .rows[0].owner_user_id
          );
        const read = async (tenantId: string) =>
          (
            await query(
              "SELECT whats_new_digest AS on, whats_new_digest_invitation AS invitation FROM exomem_tenants WHERE id = $1",
              [tenantId]
            )
          ).rows[0];
        const {
          setMonthlyUpdateEmail,
          dismissMonthlyUpdateInvitation,
          operatorTurnOnMonthlyUpdateEmail,
        } = await import("../setting");

        // An owner who existed before the digest: off, invited once.
        const existing = await seedOwner({ digest: false });
        await query(
          "UPDATE exomem_tenants SET whats_new_digest_invitation = 'open' WHERE id = $1",
          [existing.tenantId]
        );
        const principal = { tenantId: existing.tenantId, userId: await ownerOf(existing.tenantId) };
        assert.deepEqual(await dismissMonthlyUpdateInvitation(principal), {
          enabled: false,
          invited: false,
        });
        assert.deepEqual(await setMonthlyUpdateEmail(principal, true), {
          enabled: true,
          invited: false,
        });
        assert.deepEqual(await setMonthlyUpdateEmail(principal, false), {
          enabled: false,
          invited: false,
        });
        assert.equal((await read(existing.tenantId)).invitation, "accepted");

        // Turned on then unsubscribed: never asked again, even if the column were reopened by hand.
        const asked = await seedOwner({ digest: false });
        await query(
          "UPDATE exomem_tenants SET whats_new_digest_invitation = 'open' WHERE id = $1",
          [asked.tenantId]
        );
        const askedPrincipal = { tenantId: asked.tenantId, userId: await ownerOf(asked.tenantId) };
        await setMonthlyUpdateEmail(askedPrincipal, true);
        await post(unsubscribeAddressFor(asked.tenantId));
        assert.deepEqual(await dismissMonthlyUpdateInvitation(askedPrincipal), {
          enabled: false,
          invited: false,
        });

        // The operator's action, on a tenant who asked: on, invitation closed, who and when recorded.
        const asking = await seedOwner({ digest: false });
        await query(
          "UPDATE exomem_tenants SET whats_new_digest_invitation = 'open' WHERE id = $1",
          [asking.tenantId]
        );
        const principalDigest = createHash("sha256").update("operator").digest();
        assert.equal(
          await operatorTurnOnMonthlyUpdateEmail(asking.tenantId, principalDigest),
          true
        );
        const turned = (
          await query(
            "SELECT whats_new_digest_invitation AS invitation, whats_new_digest_operator_on_by AS by, whats_new_digest_operator_on_at AS at FROM exomem_tenants WHERE id = $1",
            [asking.tenantId]
          )
        ).rows[0];
        assert.deepEqual([(await read(asking.tenantId)).on, turned.invitation], [true, "accepted"]);
        assert.ok(Buffer.from(turned.by).equals(principalDigest) && turned.at instanceof Date);

        // A reviewer's tenant and a deleted account are not owners with such a setting.
        const reviewer = await seedOwner({ reviewer: true, digest: false });
        assert.equal(
          await operatorTurnOnMonthlyUpdateEmail(reviewer.tenantId, principalDigest),
          false
        );
        assert.equal(
          await setMonthlyUpdateEmail(
            { tenantId: reviewer.tenantId, userId: await ownerOf(reviewer.tenantId) },
            true
          ),
          null
        );
        assert.equal(await operatorTurnOnMonthlyUpdateEmail(randomUUID(), principalDigest), false);
      });

      it("is changed through the operator route only with the admin token, and by Home only with a session", async () => {
        const target = await seedOwner({ digest: false });
        const call = (token: string | null, body: unknown) =>
          operatorTurnOnPost(
            new NextRequest("https://substratesystems.io/api/exomem/admin/monthly-update-email", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(body),
            })
          );
        assert.equal((await call(null, { tenantId: target.tenantId })).status, 401);
        assert.equal((await call("wrong", { tenantId: target.tenantId })).status, 401);
        assert.equal((await call(ADMIN_TOKEN, { tenantId: "not-a-uuid" })).status, 400);
        assert.equal((await call(ADMIN_TOKEN, { tenantId: randomUUID() })).status, 404);
        assert.equal(await setting(target.tenantId), false);
        assert.equal((await call(ADMIN_TOKEN, { tenantId: target.tenantId })).status, 200);
        assert.equal(await setting(target.tenantId), true);

        const unauthenticated = await homeSettingPut(
          new NextRequest("https://substratesystems.io/api/exomem/account/monthly-update-email", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          })
        );
        assert.equal(unauthenticated.status, 401);
        assert.equal(await setting(target.tenantId), true);
      });
    });
  }
);

describe("the migration that adds the setting", { skip: !databaseUrl }, () => {
  it("leaves every existing owner off and invited, and a row written without a signup choice off", async () => {
    // A database as it was before this migration: every migration up to the one before it.
    const dir = mkdtempSync(join(tmpdir(), "whats-new-migration-"));
    const schema = `whats_new_migration_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    try {
      for (const file of readdirSync(resolve(process.cwd(), "migrations")).sort()) {
        if (file < "0098")
          cpSync(join(resolve(process.cwd(), "migrations"), file), join(dir, file));
      }
      await ensureExomemPostgresTestExtensions(databaseUrl!);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir: dir });
      const pool = new Pool({ connectionString: scoped.toString() });
      try {
        const user = await pool.query(
          "INSERT INTO exomem_users (email) VALUES ('before@example.test') RETURNING id"
        );
        const before = await pool.query(
          "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
          [user.rows[0].id]
        );

        await applyMigrations({
          databaseUrl: scoped.toString(),
          migrationsDir: resolve(process.cwd(), "migrations"),
        });

        const afterUser = await pool.query(
          "INSERT INTO exomem_users (email) VALUES ('after@example.test') RETURNING id"
        );
        const after = await pool.query(
          "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
          [afterUser.rows[0].id]
        );
        const rows = (
          await pool.query(
            "SELECT id, whats_new_digest AS on, whats_new_digest_invitation AS invitation FROM exomem_tenants WHERE id = ANY($1::uuid[])",
            [[before.rows[0].id, after.rows[0].id]]
          )
        ).rows;
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.deepEqual(
          [byId.get(before.rows[0].id).on, byId.get(before.rows[0].id).invitation],
          [false, "open"]
        );
        // Only a signup that showed the switch opts an owner in; any other row is off and never invited.
        assert.deepEqual(
          [byId.get(after.rows[0].id).on, byId.get(after.rows[0].id).invitation],
          [false, "none"]
        );
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
