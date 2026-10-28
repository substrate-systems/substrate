import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateImportAdmission, cloudImportReply } from "../cloud-import-contract";

const GiB = 1024 ** 3;
const limits = { max_members: 500, reserve_bytes: GiB / 4, space_factor: 2, max_storage_gib: 20 };
const storage = {
  storage_gib: 4,
  grown_storage_gib: null,
  used_bytes: GiB,
  filesystem_bytes: 4 * GiB,
  observed_storage_capacity_bytes: 4 * GiB,
};

test("unpublished or invalid creation limits never invent an admission limit", () => {
  for (const value of [null, [], {}, { ...limits, max_members: 0 }])
    assert.equal(calculateImportAdmission(value, storage, 1, 1), null);
});

test("unknown usage treats the whole current volume as used without a stale ratio", () => {
  const result = calculateImportAdmission(
    limits,
    { ...storage, grown_storage_gib: 6, used_bytes: null, filesystem_bytes: GiB },
    GiB,
    1
  )!;
  assert.equal(result.need_bytes, 8.25 * GiB);
  assert.equal(result.required_storage_gib, 9);
});

test("a stale capacity ratio sizes growth but cannot refuse an import that fits an empty vault", () => {
  const result = calculateImportAdmission(
    limits,
    {
      ...storage,
      storage_gib: 20,
      filesystem_bytes: Math.floor(1.9 * GiB),
      observed_storage_capacity_bytes: 20 * GiB,
    },
    GiB,
    1
  )!;
  assert.ok(result.need_bytes > 20 * GiB);
  assert.equal(result.required_storage_gib, 20);
  assert.equal(result.refusal, null);
});

test("admission returns content-free member and unscaled storage limits", () => {
  assert.deepEqual(calculateImportAdmission(limits, storage, 1, 501)!.refusal, {
    code: "IMPORT_TOO_MANY_FILES",
    limit: { unit: "files", value: 500, requested: 501 },
  });
  assert.deepEqual(calculateImportAdmission(limits, storage, 10 * GiB, 1)!.refusal, {
    code: "IMPORT_STORAGE_LIMIT",
    limit: { unit: "bytes", value: 20 * GiB, requested: 20.25 * GiB },
  });
});

test("an above-cap cell admits against its larger published cap", () => {
  const result = calculateImportAdmission(
    { ...limits, max_storage_gib: 30 },
    { ...storage, storage_gib: 30 },
    12 * GiB,
    1
  )!;
  assert.equal(result.current_storage_bytes, 30 * GiB);
  assert.equal(result.required_storage_gib, 26);
  assert.equal(result.refusal, null);
});

test("an older import reply parses without any new optional fields", () => {
  const older = {
    import: {
      import_id: "11111111-1111-4111-8111-111111111111",
      kind: "adopt",
      declared_bytes: 1,
      declared_files: 1,
      requested_state: "requested",
      observed_state: "pending",
      recipient: null,
      part_urls: null,
      urls_expire_at: null,
      error_code: null,
      ciphertext_sha256: null,
      ciphertext_bytes: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
  assert.deepEqual(cloudImportReply.parse(older), older);
});
