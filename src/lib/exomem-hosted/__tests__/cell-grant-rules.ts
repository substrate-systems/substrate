import assert from "node:assert/strict";
import type { KeyObject } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";

/**
 * What the Exomem cell enforces on an operation grant (`cloud_grant.py` and
 * `cloud_origin.signed_claims`, contain-cloud-controller-compromise D4), written out as assertions.
 * Reaching the same verdict here is the contract between the two repositories, so change a rule
 * in both at once.
 */
const GRANT_AUDIENCE = "exomem-cell-operation";
const GRANT_MAX_LIFETIME_SECONDS = 72 * 3600;
const CANONICAL_UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const COMMON_CLAIMS = [
  "aud",
  "cell_id",
  "exp",
  "iat",
  "jti",
  "object_key",
  "operation",
  "operation_id",
  "tenant_id",
];
const PAYLOAD_CLAIMS = {
  export: [],
  import: ["ciphertext_bytes", "ciphertext_sha256"],
} as const;

export type ExpectedGrant = {
  operation: "export" | "import";
  tenantId: string;
  cellId: string;
  operationId: string;
  objectKey: string;
  ciphertextBytes?: number;
  ciphertextSha256?: string;
};

/** Asserts that the cell would accept `token` for `expected`, and returns its claims. */
export async function assertCellAcceptsGrant(
  token: unknown,
  publicKey: KeyObject,
  expected: ExpectedGrant
): Promise<Record<string, unknown>> {
  assert.equal(typeof token, "string", "a grant is a compact JWT string");
  const header = decodeProtectedHeader(token as string);
  assert.equal(header.typ, "JWT");
  assert.equal(header.alg, "EdDSA");

  const { payload } = await jwtVerify(token as string, publicKey, {
    algorithms: ["EdDSA"],
    audience: GRANT_AUDIENCE,
  });
  const claims = payload as Record<string, unknown>;

  // Exactly these claims: the cell refuses a grant with one more or one fewer.
  assert.deepEqual(
    Object.keys(claims).sort(),
    [...COMMON_CLAIMS, ...PAYLOAD_CLAIMS[expected.operation]].sort()
  );
  assert.equal(claims.aud, GRANT_AUDIENCE);

  assert.equal(typeof claims.iat, "number");
  assert.equal(typeof claims.exp, "number");
  assert.ok(Number.isInteger(claims.iat) && Number.isInteger(claims.exp));
  const lifetime = (claims.exp as number) - (claims.iat as number);
  assert.ok(lifetime > 0 && lifetime <= GRANT_MAX_LIFETIME_SECONDS, `lifetime ${lifetime}`);
  assert.equal(typeof claims.jti, "string");
  assert.notEqual(claims.jti, "");

  assert.equal(claims.cell_id, expected.cellId);
  assert.equal(claims.operation, expected.operation);
  assert.match(String(claims.tenant_id), CANONICAL_UUID);
  assert.equal(claims.tenant_id, expected.tenantId);
  assert.match(String(claims.operation_id), CANONICAL_UUID);
  assert.equal(claims.operation_id, expected.operationId);

  // The object key sits under the cell's own prefix and the Job's URL must equal it.
  const objectKey = String(claims.object_key);
  assert.ok(objectKey.startsWith(`cells/${expected.cellId}/`));
  for (const segment of objectKey.split("/")) assert.ok(!["", ".", ".."].includes(segment));
  assert.equal(objectKey, expected.objectKey);

  if (expected.operation === "import") {
    assert.ok(Number.isInteger(claims.ciphertext_bytes) && (claims.ciphertext_bytes as number) > 0);
    assert.match(String(claims.ciphertext_sha256), /^[0-9a-f]{64}$/);
    assert.equal(claims.ciphertext_bytes, expected.ciphertextBytes);
    assert.equal(claims.ciphertext_sha256, expected.ciphertextSha256);
  }
  return claims;
}
