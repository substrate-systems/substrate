import { randomUUID } from "node:crypto";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  ExomemBillingError,
  paddleTransportUntil,
  readExomemPaddleCustomerEmail,
  updateExomemPaddleCustomerEmail,
  type PaddleTransport,
} from "./paddle-billing";
import {
  assertExomemPaddlePurpose,
  loadExomemPaddleTransactionConfig,
  type ExomemPaddleConfig,
  type ExomemPaddleEnvironment,
} from "./paddle-config";

const CONTACT_LEASE_SECONDS = 60;
// A targeted readback repairs a late provider write without scanning unrelated customers.
const CONTACT_RECHECK_HOURS = 6;

type Observation = {
  provider_environment: string | null;
  provider_customer_ref: string | null;
  observed_email: string | null;
  observed_at: Date | string | null;
};

/** Caller holds the tenant lock. Preserve a dispatched lease and only the current binding's observation. */
export async function recordPaddleReceiptContactIntent(
  tx: ExomemSql,
  tenantId: string
): Promise<void> {
  const { rows } = await tx`
    SELECT contact.provider_environment, contact.provider_customer_ref, contact.observed_email, contact.observed_at,
      entitlement.provider_environment AS current_environment, entitlement.provider_customer_ref AS current_customer
    FROM exomem_paddle_receipt_contacts AS contact
    LEFT JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = contact.tenant_id AND entitlement.source = 'paddle'
    WHERE contact.tenant_id = ${tenantId}::uuid
    FOR UPDATE OF contact
  `;
  const prior = rows[0] as
    | (Observation & { current_environment: string | null; current_customer: string | null })
    | undefined;
  const keep =
    prior &&
    prior.provider_environment === prior.current_environment &&
    prior.provider_customer_ref === prior.current_customer;
  await tx`
    INSERT INTO exomem_paddle_receipt_contacts (tenant_id)
    VALUES (${tenantId}::uuid)
    ON CONFLICT (tenant_id) DO UPDATE
    SET desired_revision = gen_random_uuid(), state = 'pending', attempts = 0,
      next_attempt_at = now(), last_error_code = NULL, updated_at = now(),
      provider_environment = ${keep ? prior.provider_environment : null},
      provider_customer_ref = ${keep ? prior.provider_customer_ref : null},
      observed_email = ${keep ? prior.observed_email : null}, observed_at = ${keep ? prior.observed_at : null}
  `;
}

type Target = Observation & {
  tenant_id: string;
  desired_revision: string;
  state: string;
  email: string;
  environment: ExomemPaddleEnvironment;
  customer_id: string;
  attempts: number;
  lease_owner: string | null;
  lease_live: boolean;
  due: boolean;
};
type Claim = {
  tenantId: string;
  revision: string;
  leaseOwner: string;
  email: string;
  environment: ExomemPaddleEnvironment;
  customerId: string;
};

async function lockTarget(
  tx: ExomemSql,
  tenantId: string,
  environment: ExomemPaddleEnvironment
): Promise<Target | undefined> {
  const tenant = await tx`
    SELECT id FROM exomem_tenants
    WHERE id = ${tenantId}::uuid AND status IN ('provisioning', 'active', 'suspended')
      AND desired_state <> 'deleted' AND deleted_at IS NULL AND marketplace_reviewer_purpose = false
    FOR UPDATE SKIP LOCKED
  `;
  if (!tenant.rows.length) return undefined;
  const { rows } = await tx`
    SELECT contact.*, owner.email::text AS email,
      entitlement.provider_environment AS environment, entitlement.provider_customer_ref AS customer_id,
      contact.lease_expires_at > now() AS lease_live,
      (contact.next_attempt_at <= now() OR contact.attempted_provider_environment IS DISTINCT FROM entitlement.provider_environment
        OR contact.attempted_provider_customer_ref IS DISTINCT FROM entitlement.provider_customer_ref) AS due
    FROM exomem_paddle_receipt_contacts AS contact
    JOIN exomem_tenants AS tenant ON tenant.id = contact.tenant_id
    JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id AND owner.deleted_at IS NULL
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    WHERE contact.tenant_id = ${tenantId}::uuid AND entitlement.source = 'paddle'
      AND entitlement.provider_environment = ${environment} AND entitlement.provider_customer_ref IS NOT NULL
      AND contact.state IN ('pending', 'synchronized')
    FOR UPDATE OF contact
  `;
  return rows[0] as Target | undefined;
}

function matches(row: Target | undefined, claim: Claim): row is Target {
  return Boolean(
    row &&
    row.desired_revision === claim.revision &&
    row.lease_owner === claim.leaseOwner &&
    row.lease_live &&
    row.email === claim.email &&
    row.environment === claim.environment &&
    row.customer_id === claim.customerId
  );
}

async function claimTarget(
  tenantId: string,
  environment: ExomemPaddleEnvironment
): Promise<Claim | null> {
  return withExomemTransaction(async (tx) => {
    const row = await lockTarget(tx, tenantId, environment);
    if (!row || !row.due || row.lease_live) return null;
    const leaseOwner = randomUUID();
    await tx`
      UPDATE exomem_paddle_receipt_contacts
      SET state = 'pending', lease_owner = ${leaseOwner}::uuid,
        lease_expires_at = now() + (${CONTACT_LEASE_SECONDS} * interval '1 second'),
        attempted_provider_environment = ${row.environment}, attempted_provider_customer_ref = ${row.customer_id},
        attempts = attempts + 1, updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid
    `;
    return {
      tenantId,
      revision: row.desired_revision,
      leaseOwner,
      email: row.email,
      environment,
      customerId: row.customer_id,
    };
  });
}

async function claimStillCurrent(claim: Claim): Promise<boolean> {
  return withExomemTransaction(async (tx) =>
    matches(await lockTarget(tx, claim.tenantId, claim.environment), claim)
  );
}

type Outcome = {
  state: "pending" | "synchronized" | "conflict" | "failed";
  errorCode: string | null;
  observedEmail: string | null;
  observedAt: Date | null;
};
async function completeClaim(claim: Claim, outcome: Outcome): Promise<boolean> {
  return withExomemTransaction(async (tx) => {
    const row = await lockTarget(tx, claim.tenantId, claim.environment);
    if (!matches(row, claim)) return false;
    const keep =
      row.provider_environment === claim.environment &&
      row.provider_customer_ref === claim.customerId;
    await tx`
      UPDATE exomem_paddle_receipt_contacts
      SET state = ${outcome.state}, last_error_code = ${outcome.errorCode},
        provider_environment = ${outcome.observedEmail !== null ? claim.environment : keep ? row.provider_environment : null},
        provider_customer_ref = ${outcome.observedEmail !== null ? claim.customerId : keep ? row.provider_customer_ref : null},
        observed_email = ${outcome.observedEmail ?? (keep ? row.observed_email : null)},
        observed_at = ${outcome.observedAt ?? (keep ? row.observed_at : null)},
        next_attempt_at = CASE WHEN ${outcome.state} = 'synchronized' THEN now() + (${CONTACT_RECHECK_HOURS} * interval '1 hour')
          ELSE now() + (${Math.min(60, 2 ** Math.min(row.attempts - 1, 6))} * interval '1 minute') END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE tenant_id = ${claim.tenantId}::uuid AND desired_revision = ${claim.revision}::uuid AND lease_owner = ${claim.leaseOwner}::uuid
    `;
    return true;
  });
}

function terminalState(error: unknown): "conflict" | "failed" | null {
  if (!(error instanceof ExomemBillingError)) return null;
  if (error.code === "EXOMEM_BILLING_INPUT_REJECTED") return "failed";
  if (error.providerStatus === 409 && error.providerCode === "customer_already_exists")
    return "conflict";
  const status = error.providerStatus;
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429
    ? "failed"
    : null;
}

async function reconcileClaim(
  claim: Claim,
  config: ExomemPaddleConfig,
  transport: PaddleTransport
): Promise<Outcome> {
  let observedEmail: string | null = null;
  let observedAt: Date | null = null;
  let failure: unknown;
  const input = { customerId: claim.customerId, environment: claim.environment };
  const deps = { config, transport };
  try {
    observedEmail = await readExomemPaddleCustomerEmail(input, deps);
    observedAt = new Date();
    if (observedEmail.toLowerCase() !== claim.email.toLowerCase()) {
      if (!(await claimStillCurrent(claim)))
        return {
          state: "pending",
          errorCode: "SUPERSEDED_CONTACT",
          observedEmail: null,
          observedAt: null,
        };
      try {
        await updateExomemPaddleCustomerEmail({ ...input, email: claim.email }, deps);
      } catch (error) {
        failure = error;
      }
      // A lost PATCH response says nothing about the remote result. An independent GET can prove it.
      observedEmail = await readExomemPaddleCustomerEmail(input, deps);
      observedAt = new Date();
    }
    if (observedEmail.toLowerCase() === claim.email.toLowerCase())
      return { state: "synchronized", errorCode: null, observedEmail, observedAt };
  } catch (error) {
    failure ??= error;
  }
  const terminal = terminalState(failure);
  return {
    state: terminal ?? "pending",
    errorCode:
      terminal === "conflict"
        ? "RECEIPT_EMAIL_CONFLICT"
        : terminal
          ? "RECEIPT_UPDATE_REFUSED"
          : "RECEIPT_UPDATE_PENDING",
    observedEmail,
    observedAt,
  };
}

export async function runBoundedPaddleReceiptContacts(
  options: { maxContacts?: number; timeBudgetMs?: number } = {},
  dependencies: { config?: ExomemPaddleConfig; transport?: PaddleTransport } = {}
) {
  const result = {
    configured: false,
    attempted: 0,
    synchronized: 0,
    pending: 0,
    conflict: 0,
    failed: 0,
    superseded: 0,
  };
  let config: ExomemPaddleConfig;
  try {
    config = dependencies.config ?? loadExomemPaddleTransactionConfig();
    assertExomemPaddlePurpose(config, "customer");
  } catch {
    return result;
  }
  result.configured = true;
  const { rows } = await executeExomemSql`
    SELECT contact.tenant_id FROM exomem_paddle_receipt_contacts AS contact
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = contact.tenant_id
    WHERE contact.state IN ('pending', 'synchronized')
      AND (contact.lease_expires_at IS NULL OR contact.lease_expires_at <= now())
      AND (contact.next_attempt_at <= now() OR contact.attempted_provider_environment IS DISTINCT FROM entitlement.provider_environment
        OR contact.attempted_provider_customer_ref IS DISTINCT FROM entitlement.provider_customer_ref)
      AND entitlement.source = 'paddle' AND entitlement.provider_environment = ${config.environment}
      AND entitlement.provider_customer_ref IS NOT NULL
    ORDER BY contact.next_attempt_at LIMIT ${Math.max(1, Math.min(options.maxContacts ?? 5, 20))}
  `;
  const deadline = AbortSignal.timeout(Math.max(250, options.timeBudgetMs ?? 8_000));
  const transport = paddleTransportUntil(deadline, dependencies.transport);
  for (const row of rows) {
    if (deadline.aborted) break;
    const claim = await claimTarget(row.tenant_id as string, config.environment);
    if (!claim) continue;
    result.attempted += 1;
    const outcome = await reconcileClaim(claim, config, transport);
    if (await completeClaim(claim, outcome)) result[outcome.state] += 1;
    else result.superseded += 1;
  }
  return result;
}

export async function loadPaddleReceiptContact(session: { tenantId: string; userId: string }) {
  const { rows } = await executeExomemSql`
    SELECT contact.state, contact.last_error_code,
      entitlement.provider_customer_ref IS NOT NULL AND entitlement.provider_environment IS NOT NULL AS available,
      CASE WHEN contact.provider_environment = entitlement.provider_environment AND contact.provider_customer_ref = entitlement.provider_customer_ref THEN contact.observed_email END AS observed_email,
      CASE WHEN contact.provider_environment = entitlement.provider_environment AND contact.provider_customer_ref = entitlement.provider_customer_ref THEN contact.observed_at END AS observed_at
    FROM exomem_tenants AS tenant
    LEFT JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id AND entitlement.source = 'paddle'
    LEFT JOIN exomem_paddle_receipt_contacts AS contact ON contact.tenant_id = tenant.id
    WHERE tenant.id = ${session.tenantId}::uuid AND tenant.owner_user_id = ${session.userId}::uuid
      AND tenant.deleted_at IS NULL AND tenant.status NOT IN ('deleted', 'deletion_pending')
  `;
  const row = rows[0] as
    | {
        state: string | null;
        last_error_code: string | null;
        available: boolean;
        observed_email: string | null;
        observed_at: Date | string | null;
      }
    | undefined;
  return row
    ? {
        state: row.state,
        available: row.available,
        knownEmail: row.observed_email,
        observedAt: row.observed_at ? new Date(row.observed_at).toISOString() : null,
        observationSource: row.observed_email === null ? null : "paddle_customer",
        errorCode: row.last_error_code,
      }
    : null;
}
