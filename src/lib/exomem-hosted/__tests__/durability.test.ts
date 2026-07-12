import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getOwnerExport,
  listOwnerExports,
  ownerExportDownload,
  requestOwnerExport,
  requestOwnerRestore,
  type OwnerExportPrivate,
} from "../durability";
import { __setExomemSqlForTests } from "../db";
import { ExomemHostedError } from "../errors";
import { InMemoryLifecycleStore } from "../reconciler";
import { digestSecret, encryptSecret } from "../security";
import type { GatewayTarget } from "../db";

const USER = "018f2d91-7c42-7000-8000-000000000081";
const TENANT = "018f2d91-7c42-7000-8000-000000000082";
const CELL = "018f2d91-7c42-7000-8000-000000000083";
const EXPORT = "018f2d91-7c42-7000-8000-000000000084";

afterEach(() => __setExomemSqlForTests(null));

function target(overrides: Partial<GatewayTarget> = {}): GatewayTarget {
  return {
    userId: USER,
    tenantId: TENANT,
    tenantStatus: "active",
    tenantDesiredState: "running",
    cellId: CELL,
    cellLifecycleState: "active",
    cellRoutingState: "bound",
    protocolVersion: "1",
    releaseVersion: "0.19.1",
    credentialCiphertext: null,
    endpointCiphertext: null,
    entitlementSource: "complimentary",
    entitlementSourceState: "complimentary_active",
    entitlementEffectiveState: "active",
    capabilities: ["capture", "recall", "export"],
    resourceLimits: { storageBytes: 1000, uploadBytes: 100, workerCount: 0 },
    manuallySuspended: false,
    ...overrides,
  };
}

function storedExport(overrides: Partial<OwnerExportPrivate> = {}): OwnerExportPrivate {
  const reference = "provider-export-reference-1";
  return {
    exportId: EXPORT,
    operationId: "018f2d91-7c42-7000-8000-000000000085",
    requestId: "018f2d91-7c42-7000-8000-000000000086",
    state: "available",
    archiveSize: 1024,
    archiveSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    createdAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2099-07-13T12:00:00.000Z",
    errorCode: null,
    tenantId: TENANT,
    cellId: CELL,
    fenceGeneration: 1,
    storageReferenceEnvelope: encryptSecret(reference, {
      key: Buffer.alloc(32, 0x31),
      randomBytes: (size) => Buffer.alloc(size, 0x32),
    }),
    storageReferenceDigest: digestSecret(reference),
    ...overrides,
  };
}

describe("owner Exomem durability workflows", () => {
  it("queues one idempotent export from authoritative capability and cell state", async () => {
    const store = new InMemoryLifecycleStore();
    let reconciled = "";
    const result = await requestOwnerExport(
      { userId: USER, tenantId: TENANT, idempotencyKey: "owner-export-1" },
      {
        resolveTarget: async () => target(),
        enqueue: store.enqueue.bind(store),
        reconcile: async (tenantId) => {
          reconciled = tenantId;
          return { attempted: true, code: "RECONCILE_STEP_ACCEPTED" };
        },
      }
    );

    assert.equal(result.state, "processing");
    assert.equal(reconciled, TENANT);
    const operation = store.operations.get(result.operationId);
    assert.equal(operation?.operationType, "export");
    assert.equal(operation?.cellId, CELL);
  });

  it("uses the encrypted provider reference when queuing replacement restore", async () => {
    const store = new InMemoryLifecycleStore();
    const record = storedExport();
    const result = await requestOwnerRestore(
      {
        userId: USER,
        tenantId: TENANT,
        exportId: EXPORT,
        idempotencyKey: "owner-restore-1",
      },
      {
        resolveTarget: async () => target(),
        getExport: async () => record,
        enqueue: store.enqueue.bind(store),
        reconcile: async () => ({ attempted: true, code: "RECONCILE_STEP_ACCEPTED" }),
      }
    );

    const operation = store.operations.get(result.operationId);
    assert.equal(operation?.operationType, "restore");
    assert.deepEqual(operation?.inputReferenceEnvelope, record.storageReferenceEnvelope);
    assert.equal(operation?.inputReferenceDigest?.equals(record.storageReferenceDigest), true);
    assert.equal(operation?.inputSourceCellId, CELL);
    assert.equal(operation?.inputArchiveSha256, record.archiveSha256);
    assert.equal(operation?.inputManifestSha256, record.manifestSha256);
    assert.equal(operation?.inputArchiveSize, record.archiveSize);
    assert.equal(operation?.inputExportId, EXPORT);
    assert.equal(JSON.stringify(operation).includes("provider-export-reference-1"), false);
  });

  it("keeps expired artifacts out of owner reads while preserving pending operation visibility", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("exomem:list-owner-exports")) {
        return {
          rows: [
            {
              export_id: null,
              operation_id: "018f2d91-7c42-7000-8000-000000000087",
              request_id: "018f2d91-7c42-7000-8000-000000000088",
              operation_state: "waiting",
              error_code: null,
              created_at: "2026-07-12T12:00:00.000Z",
              export_state: null,
              archive_size: null,
              archive_sha256: null,
              manifest_sha256: null,
              expires_at: null,
              fence_generation: 7,
            },
          ],
        };
      }
      return {
        rows: [
          {
            export_id: EXPORT,
            tenant_id: TENANT,
            cell_id: CELL,
            operation_id: "018f2d91-7c42-7000-8000-000000000085",
            request_id: "018f2d91-7c42-7000-8000-000000000086",
            created_at: "2026-07-12T12:00:00.000Z",
            error_code: null,
            export_state: "available",
            storage_reference_ciphertext: storedExport().storageReferenceEnvelope,
            storage_reference_digest: Buffer.alloc(32, 0x33),
            archive_size: 1024,
            archive_sha256: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            expires_at: "2099-07-13T12:00:00.000Z",
            fence_generation: 7,
          },
        ],
      };
    });

    const summaries = await listOwnerExports(USER, TENANT);
    assert.equal(summaries[0]?.state, "processing");
    const detail = await getOwnerExport(USER, TENANT, EXPORT);
    assert.equal(detail?.fenceGeneration, 7);
    assert.match(queries[0] ?? "", /export_row\.expires_at > now\(\)/);
    assert.match(queries[1] ?? "", /export_row\.expires_at > now\(\)/);
    assert.match(queries[1] ?? "", /tenant\.fence_generation/);
  });

  it("rejects a restore retry key rebound to a different verified export", async () => {
    const store = new InMemoryLifecycleStore();
    const first = storedExport();
    const common = {
      userId: USER,
      tenantId: TENANT,
      exportId: EXPORT,
      idempotencyKey: "restore-bound-key",
    };
    await requestOwnerRestore(common, {
      resolveTarget: async () => target(),
      getExport: async () => first,
      enqueue: store.enqueue.bind(store),
      reconcile: async () => ({ attempted: true, code: "RECONCILE_STEP_ACCEPTED" }),
    });
    await assert.rejects(
      requestOwnerRestore(common, {
        resolveTarget: async () => target(),
        getExport: async () =>
          storedExport({
            storageReferenceDigest: Buffer.alloc(32, 0x7f),
            archiveSha256: "c".repeat(64),
          }),
        enqueue: store.enqueue.bind(store),
        reconcile: async () => ({ attempted: true, code: "RECONCILE_STEP_ACCEPTED" }),
      }),
      (error) => error instanceof ExomemHostedError && error.code === "IDEMPOTENCY_KEY_REUSED"
    );
  });

  it("issues a short-lived download only after an owner-scoped available lookup", async () => {
    let called = false;
    const result = await ownerExportDownload(
      { userId: USER, tenantId: TENANT, exportId: EXPORT },
      {
        getExport: async () => storedExport(),
        createDownload: async () => {
          called = true;
          return {
            url: new URL("https://download.invalid/signed-once"),
            expiresAt: new Date("2099-07-12T12:05:00.000Z"),
          };
        },
      }
    );

    assert.equal(called, true);
    assert.equal(result.url.hostname, "download.invalid");
  });

  it("fails closed without export capability or a same-owner export", async () => {
    await assert.rejects(
      requestOwnerExport(
        { userId: USER, tenantId: TENANT, idempotencyKey: "denied-export" },
        { resolveTarget: async () => target({ capabilities: ["recall"] }) }
      ),
      (error) => error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
    await assert.rejects(
      ownerExportDownload(
        { userId: USER, tenantId: TENANT, exportId: EXPORT },
        { getExport: async () => null }
      ),
      (error) => error instanceof ExomemHostedError && error.code === "EXOMEM_EXPORT_NOT_FOUND"
    );
  });
});
