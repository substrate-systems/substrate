import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import {
  SqlExportGcStore,
  runExportGc,
  type ExportGcCandidate,
  type ExportGcStore,
} from "../export-gc";
import { FakeCellProvisioner } from "../provisioner";
import { encryptSecret } from "../security";

const EXPORT = "018f2d91-7c42-7000-8000-000000000091";
const TENANT = "018f2d91-7c42-7000-8000-000000000092";

afterEach(() => __setExomemSqlForTests(null));

function candidate(): ExportGcCandidate {
  return {
    exportId: EXPORT,
    tenantId: TENANT,
    fenceGeneration: 4,
    provisionerWireProtocol: "exomem-cell-provisioner.v2",
    storageReferenceEnvelope: encryptSecret("provider-export-object-1", {
      key: Buffer.alloc(32, 0x41),
      randomBytes: (size) => Buffer.alloc(size, 0x42),
    }),
  };
}

class MemoryGcStore implements ExportGcStore {
  next: ExportGcCandidate | null = candidate();
  completed = 0;
  retries = 0;

  async claim(): Promise<ExportGcCandidate | null> {
    return this.next;
  }

  async complete(): Promise<boolean> {
    this.completed += 1;
    this.next = null;
    return true;
  }

  async retry(): Promise<boolean> {
    this.retries += 1;
    return true;
  }
}

describe("expired Exomem export garbage collection", () => {
  it("keeps the originating operation protocol on a target-free provider delete", async () => {
    class ProtocolRecordingProvisioner extends FakeCellProvisioner {
      readonly protocols: string[] = [];

      override async deleteExport(
        request: Parameters<FakeCellProvisioner["deleteExport"]>[0]
      ) {
        this.protocols.push(request.provisionerWireProtocol ?? "missing");
        return super.deleteExport(request);
      }
    }

    const provisioner = new ProtocolRecordingProvisioner();
    await runExportGc({
      store: new MemoryGcStore(),
      provisioner,
      owner: "gc-worker",
      maxExports: 1,
      timeBudgetMs: 1_000,
      envelopeKey: Buffer.alloc(32, 0x41),
    });

    assert.deepEqual(provisioner.protocols, ["exomem-cell-provisioner.v2"]);
  });

  it("converges after a lost provider deletion acknowledgement before scrubbing the tombstone", async () => {
    const store = new MemoryGcStore();
    const provisioner = new FakeCellProvisioner();
    provisioner.loseNextAcknowledgement("delete-export");

    const first = await runExportGc({
      store,
      provisioner,
      owner: "gc-worker",
      maxExports: 1,
      timeBudgetMs: 1_000,
      envelopeKey: Buffer.alloc(32, 0x41),
    });
    assert.deepEqual(first, { attempted: 1, deleted: 0, retryScheduled: 1 });
    assert.equal(store.completed, 0);
    assert.equal(provisioner.deletedExports.has("provider-export-object-1"), true);

    const second = await runExportGc({
      store,
      provisioner,
      owner: "gc-worker",
      maxExports: 1,
      timeBudgetMs: 1_000,
      envelopeKey: Buffer.alloc(32, 0x41),
    });
    assert.deepEqual(second, { attempted: 1, deleted: 1, retryScheduled: 0 });
    assert.equal(store.completed, 1);
    assert.equal(provisioner.calls.filter((call) => call.action === "delete-export").length, 2);
    assert.equal(
      new Set(
        provisioner.calls
          .filter((call) => call.action === "delete-export")
          .map((call) => call.idempotencyKey)
      ).size,
      1
    );
  });

  it("claims only expired or retrying artifacts outside deletion and active restore pins", async () => {
    let query = "";
    __setExomemSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [] };
    });

    assert.equal(await new SqlExportGcStore().claim({ owner: "gc-worker", leaseMs: 30_000 }), null);
    assert.match(query, /export_row\.expires_at <= now\(\)/);
    assert.match(query, /tenant\.desired_state <> 'deleted'/);
    assert.match(query, /restore\.input_export_id = export_row\.id/);
    assert.match(
      query,
      /restore\.state IN \('pending', 'running', 'waiting', 'failed_retryable'\)/
    );
    assert.match(query, /FOR UPDATE OF export_row SKIP LOCKED/);
  });
});
