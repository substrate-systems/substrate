/**
 * Service credentials for Exomem Cloud (change add-cloud-service-credentials).
 *
 * A product backend holds one long-lived `exs_` secret for its tenant's cell
 * instead of a 15-minute OAuth access token. The control plane stores only the
 * secret's SHA-256 digest; the plaintext appears once, in the issue response.
 * The credential binds to the tenant, not the cell row — a rebuilt cell keeps
 * the credential working (review R1).
 *
 * The gateway lookup (`findCloudServiceCredential`) shares its tenant
 * eligibility predicate with `findCloudOAuthAuthority` through migration
 * 0088's `exomem_cloud_tenant_access_allowed` function (review B1): the tenant
 * is not pending deletion or deleted and its owner has no account block. The
 * cell `desired_state <> 'deleted'` predicate stays inline beside the partial
 * unique index it pairs with.
 */

import { executeExomemSql, withExomemTransaction } from "./db";
import {
  REQUIRED_CLOUD_SCOPES,
  type ActiveCloudOAuthAccessToken,
} from "./cloud-oauth";
import { exomemErrors } from "./errors";
import { digestSecret, generateExternalToken } from "./security";
import {
  SERVICE_CREDENTIAL_PREFIX,
  SERVICE_CREDENTIAL_PRINCIPAL_FORMAT,
} from "./service-credential-format";

/** Design D5: rotation without downtime is exactly two live credentials. */
const MAX_LIVE_CREDENTIALS_PER_PRINCIPAL = 2;

/** A fresh `exs_` secret: the prefix plus 32 random bytes in base64url (D2). */
export function generateCloudServiceCredentialSecret(): string {
  return `${SERVICE_CREDENTIAL_PREFIX}${generateExternalToken()}`;
}

/**
 * The pass-through's access shape (design D3) resolved from a service
 * credential rather than an OAuth token. `serviceCredential` marks the
 * credential kind for the two places the pass-through must differ: the IP
 * bucket is skipped for a resolved credential (D4), and Home's app-use record
 * does not apply — the credential is not an OAuth grant.
 */
export type ActiveCloudServiceCredential = ActiveCloudOAuthAccessToken & {
  serviceCredential: true;
};

type ServiceCredentialSelector = { tenantId: string } | { ownerEmail: string };

type ServiceCredentialRow = {
  id: string;
  tenant_id: string;
  principal: string;
  created_at: string;
  revoked_at: string | null;
};

function selectorKey(input: ServiceCredentialSelector): { tenantId: string | null; email: string | null } {
  return "tenantId" in input
    ? { tenantId: input.tenantId, email: null }
    : { tenantId: null, email: input.ownerEmail };
}

/**
 * Issues a service credential for one tenant and principal (design D5). The
 * tenant row is locked for the transaction so two concurrent issues cannot
 * both pass the two-live-credential count. Returns the stored facts and the
 * plaintext secret, which only the issue response may reveal.
 */
export async function issueCloudServiceCredentialAtomic(input: {
  principal: string;
  operatorPrincipalDigest: Buffer;
} & ServiceCredentialSelector): Promise<{
  credentialId: string;
  tenantId: string;
  principal: string;
  cellId: string;
  secret: string;
}> {
  if (!SERVICE_CREDENTIAL_PRINCIPAL_FORMAT.test(input.principal)) {
    throw exomemErrors.invalidRequest();
  }
  const selector = selectorKey(input);
  const secret = generateCloudServiceCredentialSecret();
  return withExomemTransaction(async (tx) => {
    // Resolve and lock the tenant in one statement, under the same
    // eligibility predicates the gateway lookup applies: a tenant leaving or
    // blocked never receives a new credential, and a tenant without a live
    // cell has nothing for the credential to reach.
    const tenant = await tx`
      /* exomem-cloud:issue-service-credential-tenant */
      SELECT tenant.id, cell.cell_id
      FROM exomem_tenants AS tenant
      JOIN exomem_cloud_cells AS cell
        ON cell.tenant_id = tenant.id
       AND cell.desired_state <> 'deleted'
      WHERE (
          tenant.id = ${selector.tenantId}::uuid
          OR (
            ${selector.tenantId}::uuid IS NULL
            AND tenant.owner_user_id = (
              SELECT owner.id FROM exomem_users AS owner
              WHERE owner.email = ${selector.email}::citext
            )
          )
        )
        AND exomem_cloud_tenant_access_allowed(tenant.id, tenant.owner_user_id)
        -- Review R2: a marketplace-reviewer's credentials have their own
        -- expiry contract; a long-lived service credential would sidestep it.
        AND NOT tenant.marketplace_reviewer_purpose
      LIMIT 1
      FOR UPDATE OF tenant
    `;
    const row = tenant.rows[0] as { id: string; cell_id: string } | undefined;
    // R2: one distinct code for every tenant state that cannot hold a
    // credential — gone cells, leaving or blocked tenants, and marketplace
    // reviewers — so the operator sees why rather than a bare INVALID_REQUEST.
    if (!row) throw exomemErrors.serviceCredentialTenantIneligible();
    const live = await tx`
      /* exomem-cloud:issue-service-credential-count */
      SELECT count(*)::integer AS count
      FROM exomem_cloud_service_credentials
      WHERE tenant_id = ${row.id}::uuid
        AND principal = ${input.principal}
        AND revoked_at IS NULL
    `;
    if (Number(live.rows[0]?.count ?? 0) >= MAX_LIVE_CREDENTIALS_PER_PRINCIPAL) {
      throw exomemErrors.serviceCredentialLimit();
    }
    const inserted = await tx`
      /* exomem-cloud:issue-service-credential */
      INSERT INTO exomem_cloud_service_credentials (
        tenant_id, principal, secret_digest, created_by_principal_digest
      ) VALUES (
        ${row.id}::uuid, ${input.principal}, ${digestSecret(secret)}, ${input.operatorPrincipalDigest}
      )
      RETURNING id
    `;
    return {
      credentialId: String(inserted.rows[0]!.id),
      tenantId: row.id,
      principal: input.principal,
      cellId: row.cell_id,
      secret,
    };
  });
}

/**
 * A tenant's credentials as the operator list shows them: id, principal,
 * creation and revocation times — never the secret and never its digest
 * (spec: "The secret is shown once"). Null when the tenant cannot be resolved.
 */
export async function listCloudServiceCredentials(
  input: ServiceCredentialSelector
): Promise<
  Array<{ credentialId: string; principal: string; createdAt: string; revokedAt: string | null }> | null
> {
  const selector = selectorKey(input);
  // The operator's list deliberately applies none of the gateway lookup's
  // eligibility predicates: a deleting tenant's credentials are exactly the
  // ones an operator may still need to revoke.
  const tenant = await executeExomemSql`
    /* exomem-cloud:list-service-credentials-tenant */
    SELECT tenant.id FROM exomem_tenants AS tenant
    WHERE tenant.id = ${selector.tenantId}::uuid
       OR (
         ${selector.tenantId}::uuid IS NULL
         AND tenant.owner_user_id = (
           SELECT owner.id FROM exomem_users AS owner
           WHERE owner.email = ${selector.email}::citext
         )
       )
    LIMIT 1
  `;
  const tenantId = tenant.rows[0]?.id as string | undefined;
  if (!tenantId) return null;
  const { rows } = await executeExomemSql`
    /* exomem-cloud:list-service-credentials */
    SELECT credential.id, credential.principal, credential.created_at, credential.revoked_at
    FROM exomem_cloud_service_credentials AS credential
    WHERE credential.tenant_id = ${tenantId}::uuid
    ORDER BY credential.created_at, credential.id
  `;
  return (rows as ServiceCredentialRow[]).map((row) => ({
    credentialId: row.id,
    principal: row.principal,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  }));
}

/**
 * Revokes a credential by id (design D7). Idempotent: a repeat revoke, or one
 * naming an id that never existed, succeeds without change — the return only
 * reports whether this call was the one that revoked it.
 */
export async function revokeCloudServiceCredentialAtomic(input: {
  credentialId: string;
  operatorPrincipalDigest: Buffer;
}): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem-cloud:revoke-service-credential */
    UPDATE exomem_cloud_service_credentials
    SET revoked_at = now(), revoked_by_principal_digest = ${input.operatorPrincipalDigest}
    WHERE id = ${input.credentialId}::uuid
      AND revoked_at IS NULL
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * The gateway's `exs_` lookup (designs D2, D3). Applies the shared
 * tenant-access predicate and the inline cell predicate (see the module
 * docstring) and returns the pass-through's access shape: the credential id stands in
 * for both grant and family, the principal is the client, and the resource is
 * the configured Cloud resource the caller authenticated against. A revoked,
 * unknown, blocked or deleting credential resolves to null — indistinguishable
 * from never having existed.
 */
export async function findCloudServiceCredential(
  secretDigest: Buffer,
  expectedResource: string
): Promise<ActiveCloudServiceCredential | null> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:find-service-credential */
    SELECT credential.id, credential.tenant_id, credential.principal,
           tenant.owner_user_id AS user_id,
           cell.cell_id, cell.desired_state AS cell_desired_state
    FROM exomem_cloud_service_credentials AS credential
    JOIN exomem_tenants AS tenant
      ON tenant.id = credential.tenant_id
    JOIN exomem_cloud_cells AS cell
      ON cell.tenant_id = credential.tenant_id
     AND cell.desired_state <> 'deleted'
    WHERE credential.secret_digest = ${secretDigest}
      AND credential.revoked_at IS NULL
      AND exomem_cloud_tenant_access_allowed(credential.tenant_id, tenant.owner_user_id)
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        id: string;
        tenant_id: string;
        principal: string;
        user_id: string;
        cell_id: string;
        cell_desired_state: ActiveCloudOAuthAccessToken["cellDesiredState"];
      }
    | undefined;
  if (!row) return null;
  return {
    familyId: row.id,
    grantId: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    // The origin proof's client: the product principal, e.g.
    // service:creator-platform (D3). The client identity is synthesized from
    // the credential row — its stored principal is both the proof's client
    // and the name the cell is shown; it has no redirects, so the cell's
    // engagement context derives to the default non-local level.
    clientId: row.principal,
    resource: expectedResource,
    scopes: [...REQUIRED_CLOUD_SCOPES],
    cellId: row.cell_id,
    cellDesiredState: row.cell_desired_state,
    client: {
      clientName: row.principal,
      admissionMode: "service",
      platform: null,
      redirectUris: [],
    },
    firstParty: false,
    serviceCredential: true,
  };
}
