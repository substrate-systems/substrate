import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, it, mock } from "node:test";
import { loadCloudGrantSigningKey } from "../cloud-config";
import { signCloudOperationGrant } from "../cloud-operation-grants";

const KEY_VARIABLE = "EXOMEM_CLOUD_GRANT_SIGNING_KEY";
const CELL_ID = "abcdefghijklmnop";
const sha256 = "a".repeat(64);

function grantEnv() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { [KEY_VARIABLE]: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

describe("operation grant signer", () => {
  afterEach(() => mock.restoreAll());

  it("signs nothing, and does not fail, while no grant key is configured", async () => {
    const request = {
      operation: "export" as const,
      tenantId: randomUUID(),
      cellId: CELL_ID,
      operationId: randomUUID(),
    };
    assert.equal(await signCloudOperationGrant(request, { env: {} }), null);
    assert.equal(await signCloudOperationGrant(request, { env: { [KEY_VARIABLE]: "  " } }), null);
  });

  it("treats a key that is not an Ed25519 private key as absent and logs only the variable name", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    const { privateKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.export({ format: "pem", type: "pkcs8" }).toString();
    for (const value of ["not a key", rsaPem]) {
      assert.equal(loadCloudGrantSigningKey({ [KEY_VARIABLE]: value }), undefined);
    }
    assert.equal(warn.mock.callCount(), 2);
    for (const call of warn.mock.calls) {
      assert.deepEqual(call.arguments, [
        { event: "exomem_cloud_grant_key_invalid", variable: KEY_VARIABLE },
      ]);
    }
  });

  it("refuses to sign a claim that the cell would reject as malformed", async () => {
    const env = grantEnv();
    const base = { tenantId: randomUUID(), cellId: CELL_ID, operationId: randomUUID() };
    const rejected = [
      { operation: "export" as const, ...base, operationId: randomUUID().toUpperCase() },
      { operation: "export" as const, ...base, cellId: "short" },
      { operation: "import" as const, ...base, ciphertextBytes: 0, ciphertextSha256: sha256 },
      {
        operation: "import" as const,
        ...base,
        ciphertextBytes: 1,
        ciphertextSha256: "A".repeat(64),
      },
    ];
    for (const request of rejected) {
      await assert.rejects(signCloudOperationGrant(request, { env }));
    }
  });
});
