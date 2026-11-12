import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";

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
 * waitlist email and is not a stall), or a sign-in link failed to send. A
 * sign-in link that ended because it was used, replaced or expired is not one.
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
                       AND last_error_code IN ('EMAIL_DELIVERY_UNAVAILABLE', 'DELIVERY_PAYLOAD_INVALID'))
         ) AS failed_recently`,
      [overdueSeconds]
    );
    return {
      overdue: rows[0]?.overdue === true,
      failedRecently: rows[0]?.failed_recently === true,
    };
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
