import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { CANARY_EMAIL_KINDS, type CanaryEmail } from "./health-canary";

// These components are the closed protocol in exomem-functional-health.
export const HealthComponent = z.enum(["control", "email", "memory"]);
export type HealthComponent = z.infer<typeof HealthComponent>;
const HealthProof = z
  .object({
    component: HealthComponent,
    runId: z.uuid(),
    startedAt: z.date(),
    checkedAt: z.date(),
    success: z.boolean(),
  })
  .refine((proof) => proof.startedAt <= proof.checkedAt);
export type HealthProof = z.infer<typeof HealthProof>;

let pool: Pool | null = null;

function healthPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({
    connectionString,
    application_name: "exomem-functional-health",
    max: 2,
    connectionTimeoutMillis: 200,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  pool.on("error", () => {
    /* Unreadable proofs become unavailable; pg discards the failed connection. */
  });
  return pool;
}

async function withHealthClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const started = performance.now();
  const client = await healthPool().connect();
  let discarded = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => {
        discarded = true;
        // Destroy the socket before returning, so a timed-out query cannot keep doing work.
        client.release(true);
        reject(new Error("HEALTH_DATABASE_DEADLINE"));
      },
      Math.max(1, 850 - (performance.now() - started))
    );
  });
  try {
    return await Promise.race([
      (async () => {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = 500");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      })(),
      deadline,
    ]);
  } catch (error) {
    if (!discarded) {
      discarded = true;
      client.release(true);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!discarded) client.release();
  }
}

export async function readHealthProof(component: HealthComponent): Promise<HealthProof | null> {
  return withHealthClient(async (client) => {
    const { rows } = await client.query(
      `SELECT component, run_id AS "runId", started_at AS "startedAt",
              checked_at AS "checkedAt", success
       FROM exomem_health_proofs WHERE component = $1`,
      [HealthComponent.parse(component)]
    );
    if (!rows[0]) return null;
    const proof = HealthProof.safeParse(rows[0]);
    return proof.success ? proof.data : null;
  });
}

export async function saveHealthProof(proof: HealthProof): Promise<void> {
  HealthProof.parse(proof);
  await withHealthClient(async (client) => {
    if (proof.component === "memory") {
      await client.query("SELECT exomem_record_memory_health_proof($1, $2, $3, $4)", [
        proof.runId,
        proof.startedAt,
        proof.checkedAt,
        proof.success,
      ]);
      return;
    }
    await client.query(
      `INSERT INTO exomem_health_proofs (component, run_id, started_at, checked_at, success)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (component) DO UPDATE SET
         run_id = EXCLUDED.run_id, started_at = EXCLUDED.started_at,
         checked_at = EXCLUDED.checked_at, success = EXCLUDED.success
       -- Equal starts have no order, so a tied failure supersedes success.
       WHERE EXCLUDED.started_at > exomem_health_proofs.started_at
          OR (EXCLUDED.started_at = exomem_health_proofs.started_at
              AND exomem_health_proofs.success AND NOT EXCLUDED.success)`,
      [proof.component, proof.runId, proof.startedAt, proof.checkedAt, proof.success]
    );
  });
}

/**
 * Whether real email traffic has stalled, read through the health pool's own
 * bounded connection so a busy application pool cannot hide it. `overdue`:
 * some queued email (either outbox) has been ready but unsent for more than
 * `overdueSeconds`. `failedRecently`: some email failed in the last hour for a
 * reason that is not the provider refusing the request (a refusal ends one
 * waitlist email and is not a stall), or a sign-in link failed to send. The
 * two codes that end a sign-in link for being used, replaced or expired are
 * not one; any other code, including a new one, counts.
 */
export async function readEmailDeliveryStall(
  overdueSeconds: number
): Promise<{ overdue: boolean; failedRecently: boolean }> {
  return withHealthClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         (EXISTS (SELECT 1 FROM exomem_email_outbox
                  WHERE state IN ('pending', 'leased')
                    AND not_before < now() - make_interval(secs => $1))
          OR EXISTS (SELECT 1 FROM exomem_access_delivery_outbox
                     WHERE state IN ('pending', 'leased')
                       AND next_attempt_at < now() - make_interval(secs => $1))) AS overdue,
         (EXISTS (SELECT 1 FROM exomem_email_outbox
                  WHERE state = 'failed'
                    AND updated_at > now() - interval '1 hour'
                    AND last_error_code IS DISTINCT FROM 'EMAIL_REFUSED')
          OR EXISTS (SELECT 1 FROM exomem_access_delivery_outbox
                     WHERE state = 'failed'
                       AND updated_at > now() - interval '1 hour'
                       AND (last_error_code IS NULL
                            OR last_error_code NOT IN ('SUPERSEDED_MAGIC_LINK', 'ACCESS_TOKEN_UNAVAILABLE')))
         ) AS failed_recently`,
      [overdueSeconds]
    );
    return {
      overdue: rows[0]?.overdue === true,
      failedRecently: rows[0]?.failed_recently === true,
    };
  });
}

/**
 * The canary's newest email in the outbox that is at least `minAgeSeconds` old,
 * with the time of the provider's earliest `delivered` event for it, or `null`
 * when it has none. Read through the health pool, like the stall check. The
 * canary's rows are the ones with its address, a few dozen a day, found through
 * the outbox's recipient index.
 */
export async function readLatestCanaryEmail(
  recipient: string,
  minAgeSeconds: number
): Promise<CanaryEmail | null> {
  return withHealthClient(async (client) => {
    const { rows } = await client.query(
      `SELECT o.id, o.kind, o.state, o.created_at AS "createdAt",
              COALESCE(o.due_at, o.created_at) AS "dueAt", o.sent_at AS "sentAt",
              o.provider_message_id AS "providerMessageId",
              (SELECT min(e.occurred_at) FROM exomem_email_provider_events AS e
                WHERE e.provider_message_id = o.provider_message_id
                  AND e.event = 'delivered') AS "deliveredAt"
       FROM exomem_email_outbox AS o
       WHERE o.recipient = $1 AND o.kind = ANY($2::text[])
         AND o.created_at <= now() - make_interval(secs => $3)
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT 1`,
      [recipient, [...CANARY_EMAIL_KINDS], minAgeSeconds]
    );
    return (rows[0] as CanaryEmail | undefined) ?? null;
  });
}

export async function proveControlRoundTrip(): Promise<boolean> {
  const nonce = randomUUID();
  return withHealthClient(async (client) => {
    // A temporary row proves separate write/read operations without retaining synthetic content.
    await client.query("CREATE TEMP TABLE exomem_health_round_trip (nonce text) ON COMMIT DROP");
    await client.query("INSERT INTO exomem_health_round_trip VALUES ($1)", [nonce]);
    const { rows } = await client.query("SELECT nonce FROM exomem_health_round_trip");
    return rows.length === 1 && rows[0].nonce === nonce;
  });
}

export async function closeHealthProofPool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end();
}
