/**
 * Signed operation grants (Exomem `contain-cloud-controller-compromise`, D4).
 *
 * The control plane signs one grant for each export and each import, with a key
 * that only it holds. The Job that moves the data checks the grant before any
 * byte moves: it must be for this cell, operation and operation ID, and every
 * presigned URL must name the grant's own object key. `cellctl` relays the
 * grant from the request row and presigns the URLs, but it cannot sign.
 *
 * The cell's verifier (`cloud_grant.py`, `cloud_origin.signed_claims`) accepts
 * exactly these claims and no others: `aud`, `iat`, `exp`, `jti`, `tenant_id`,
 * `cell_id`, `operation`, `operation_id` and `object_key`, plus
 * `ciphertext_bytes` and `ciphertext_sha256` for an import. There is no `v` or
 * `iss`. Change a claim here and in that verifier in the same release.
 *
 * No restore grant: Substrate has no restore request. Restores start in the
 * cell controller or the operator tooling, so there is nothing to sign at
 * creation. A restore grant (`snapshot_id`) joins when such a request exists.
 */

import { z } from "zod";
import { loadCloudGrantSigningKey, type EnvironmentSource } from "./cloud-config";
import { signCloudJwt } from "./cloud-jwt";

export const CLOUD_GRANT_AUDIENCE = "exomem-cell-operation";
/**
 * The cell accepts `exp - iat` up to 72 hours (`GRANT_MAX_LIFETIME`). A grant names one operation
 * ID, one key and, for an import, one digest, so the full window adds no capability, and a Job
 * that waits behind a hold can still use it.
 */
const GRANT_LIFETIME_SECONDS = 72 * 3600;

// Format checks for what the cell requires of a claim: a canonical lowercase UUID, a lowercase SHA-256.
const CANONICAL_UUID = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const common = {
  tenantId: CANONICAL_UUID,
  cellId: z.string().regex(/^[a-z2-7]{16}$/),
  operationId: CANONICAL_UUID,
};
const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("export"), ...common }),
  z.strictObject({
    operation: z.literal("import"),
    ...common,
    ciphertextBytes: z.number().int().positive(),
    ciphertextSha256: SHA256,
  }),
]);

export type CloudOperationGrantRequest = z.infer<typeof requestSchema>;

/**
 * The object each operation may touch, under the cell's own prefix. The same derivation as
 * `ExportRequest.key` (exports.py) and `ImportRequest.key` (imports.py) in `cellctl`; the Job
 * refuses a presigned URL for any other key.
 */
function objectKey(request: CloudOperationGrantRequest): string {
  return request.operation === "export"
    ? `cells/${request.cellId}/exports/${request.operationId}.zip`
    : `cells/${request.cellId}/imports/${request.operationId}.age`;
}

/**
 * The signed grant for one export or import request, or null when no grant key is configured.
 * With no key the row keeps a NULL grant and the cells log `grant_missing`. A request that the
 * cell would refuse as malformed throws instead of producing a grant.
 */
export async function signCloudOperationGrant(
  request: CloudOperationGrantRequest,
  options: { env?: EnvironmentSource; now?: number } = {}
): Promise<string | null> {
  const key = loadCloudGrantSigningKey(options.env);
  if (!key) return null;
  const checked = requestSchema.parse(request);
  const claims = {
    tenant_id: checked.tenantId,
    cell_id: checked.cellId,
    operation: checked.operation,
    operation_id: checked.operationId,
    object_key: objectKey(checked),
    ...(checked.operation === "import"
      ? { ciphertext_bytes: checked.ciphertextBytes, ciphertext_sha256: checked.ciphertextSha256 }
      : {}),
  };
  return signCloudJwt(claims, {
    key,
    audience: CLOUD_GRANT_AUDIENCE,
    lifetimeSeconds: GRANT_LIFETIME_SECONDS,
    now: options.now ?? Math.floor(Date.now() / 1000),
  });
}
