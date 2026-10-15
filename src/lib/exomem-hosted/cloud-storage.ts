import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { storageRequest, type CloudStorageOperation } from "@/lib/exomem/storage-contract";
import { loadOwnerBillingAccount, type OwnerBillingAccount } from "./billing-account";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { ExomemHostedError, exomemErrors } from "./errors";
import { ExomemBillingError, paddleTransportUntil, type PaddleTransport } from "./paddle-billing";
import { lockExomemSubscriptionUpdate } from "./subscription-update-lock";
import { loadExomemPaddleConfig, type ExomemPaddleConfig } from "./paddle-config";
import {
  findStoragePayment,
  previewStorageChange,
  readStorageCatalogue,
  readStorageSubscription,
  sameStorageItems,
  storageItems,
  storageQuantities,
  storagePaymentMethodTransaction,
  storagePaymentMethodReady,
  storageSubscriptionFingerprint,
  storageTargetItems,
  storageTransport,
  updateStorageSubscription,
  type StorageItem,
  type StorageQuote,
  type StorageSubscription,
  type StoragePayment,
} from "./cloud-storage-paddle";

const GIB = 1024 ** 3;
type OperationState = CloudStorageOperation["state"];
type Cell = {
  owner_email: string;
  cell_id: string;
  storage_gib: number;
  grown_storage_gib: number | null;
  generation: string;
  paid_storage_bytes: string;
  observed_storage_pvc_uid: string | null;
  observed_storage_pvc_version: string | null;
  observed_storage_capacity_bytes: string | null;
  observed_storage_generation: string | null;
  observed_storage_at: Date | null;
};
type Operation = {
  id: string;
  tenant_id: string;
  cell_id: string;
  provider_environment: string;
  subscription_ref: string;
  state: OperationState;
  baseline_fingerprint: string;
  baseline_items: StorageItem[];
  target_items: StorageItem[];
  storage_price_id: string;
  added_quantity: number;
  added_bytes: string;
  paid_bytes_after: string;
  target_storage_gib: number;
  target_generation: string | null;
  pvc_uid: string;
  quote: StorageQuote;
  quote_expires_at: Date;
  confirmed_at: Date | null;
  payment_transaction_id: string | null;
  payment_facts: Pick<StoragePayment, "due" | "tax"> | null;
  applied_capacity_bytes: string | null;
  recovery_transaction_id: string | null;
  error_code: string | null;
};
type Dependencies = {
  config?: ExomemPaddleConfig;
  priceId?: string;
  transport?: PaddleTransport;
};
type Context = {
  account: OwnerBillingAccount;
  cell: Cell;
  config: ExomemPaddleConfig;
  transport: PaddleTransport;
};

const conflict = () =>
  new ExomemHostedError({
    code: "STORAGE_CONFLICT",
    status: 409,
    message: "The storage request changed. Check it again.",
  });
const unavailable = () =>
  new ExomemHostedError({
    code: "STORAGE_UNAVAILABLE",
    status: 503,
    message: "Storage changes are unavailable just now.",
    retryable: true,
  });
const safeNumber = (value: string | number): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw unavailable();
  return number;
};

async function loadCell(
  userId: string,
  tenantId: string,
  tx: ExomemSql = executeExomemSql
): Promise<Cell> {
  const result = await tx`
    SELECT owner.email AS owner_email, cell.cell_id, cell.storage_gib, cell.grown_storage_gib, cell.generation,
           cell.observed_storage_pvc_uid, cell.observed_storage_pvc_version,
           cell.observed_storage_capacity_bytes, cell.observed_storage_generation,
           cell.observed_storage_at, entitlement.paid_storage_bytes
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    JOIN users AS owner ON owner.id = tenant.owner_user_id
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    WHERE tenant.owner_user_id = ${userId} AND tenant.id = ${tenantId}::uuid
      AND tenant.status NOT IN ('deleted', 'deletion_pending') AND cell.desired_state <> 'deleted'
  `;
  if (!result.rows[0]) throw exomemErrors.entitlementDenied();
  return result.rows[0] as unknown as Cell;
}

async function context(userId: string, tenantId: string, deps: Dependencies): Promise<Context> {
  const account = await loadOwnerBillingAccount(userId, tenantId);
  const config = deps.config ?? loadExomemPaddleConfig();
  if (
    !account ||
    account.source !== "paddle" ||
    account.deleting ||
    !account.subscriptionRef ||
    !account.customerRef
  )
    throw exomemErrors.entitlementDenied();
  if (account.providerEnvironment !== config.environment) throw unavailable();
  return {
    account,
    config,
    cell: await loadCell(userId, tenantId),
    transport: storageTransport(config, deps.transport),
  };
}

function canPurchase(ctx: Context): void {
  // A false refusal delays only this purchase; a cancelled or suspended account must not receive another charge.
  if (
    ctx.account.sourceState !== "active" ||
    ctx.account.manuallySuspended ||
    !ctx.cell.observed_storage_pvc_uid ||
    !ctx.cell.observed_storage_pvc_version ||
    !ctx.cell.observed_storage_capacity_bytes
  )
    throw conflict();
}

async function currentSubscription(ctx: Context): Promise<StorageSubscription> {
  const value = await readStorageSubscription(ctx.account.subscriptionRef!, ctx.transport);
  if (
    value.customer_id !== ctx.account.customerRef ||
    value.custom_data?.user_id !== ctx.account.userId ||
    value.custom_data?.tenant_id !== ctx.account.tenantId
  )
    throw exomemErrors.entitlementDenied();
  return value;
}

async function operation(
  ctx: Context,
  id: string,
  tx: ExomemSql = executeExomemSql
): Promise<Operation> {
  const result = await tx`
    SELECT * FROM exomem_cloud_storage_operations
    WHERE id = ${id}::uuid AND tenant_id = ${ctx.account.tenantId}::uuid
      AND cell_id = ${ctx.cell.cell_id} AND subscription_ref = ${ctx.account.subscriptionRef}
      AND provider_environment = ${ctx.config.environment}
  `;
  if (!result.rows[0]) throw exomemErrors.entitlementDenied();
  return result.rows[0] as unknown as Operation;
}

function publicOperation(value: Operation): CloudStorageOperation {
  return {
    id: value.id,
    state: value.state,
    addedBytes: safeNumber(value.added_bytes),
    targetBytes: value.target_storage_gib * GIB,
    capacityBytes:
      value.applied_capacity_bytes === null ? null : safeNumber(value.applied_capacity_bytes),
    quote: value.payment_facts
      ? { ...value.quote, due: value.payment_facts.due, tax: value.payment_facts.tax }
      : value.quote,
    quoteExpiresAt: value.quote_expires_at.toISOString(),
    recoveryTransactionId: value.recovery_transaction_id,
  };
}

function targetStorageGiB(cell: Cell, addedBytes: number): number {
  const baseline = Math.max(
    cell.storage_gib,
    cell.grown_storage_gib ?? 0,
    Math.ceil(safeNumber(cell.observed_storage_capacity_bytes!) / GIB)
  );
  const target = baseline + Math.ceil(addedBytes / GIB);
  if (!Number.isSafeInteger(addedBytes) || target > 2_147_483_647) throw unavailable();
  return target;
}

async function preview(
  ctx: Context,
  quantity: number,
  deps: Dependencies
): Promise<CloudStorageOperation> {
  canPurchase(ctx);
  const priceId = deps.priceId ?? process.env.EXOMEM_PADDLE_STORAGE_PRICE_ID;
  if (!priceId) throw unavailable();
  const current = await currentSubscription(ctx);
  const price = await readStorageCatalogue(priceId, ctx.transport);
  const items = storageTargetItems(current, price, quantity);
  const quote = await previewStorageChange(current, items, ctx.transport);
  const existing = await executeExomemSql`
    SELECT recovery_transaction_id FROM exomem_cloud_storage_operations
    WHERE subscription_ref = ${ctx.account.subscriptionRef} AND provider_environment = ${ctx.config.environment}
      AND state = 'payment_required'
  `;
  const recoveryId = existing.rows[0]?.recovery_transaction_id;
  const cardReady =
    typeof recoveryId === "string" &&
    (await storagePaymentMethodReady(current, recoveryId, ctx.transport));
  const addedBytes = price.custom_data.exomem_storage_bytes * quantity;
  if (!Number.isSafeInteger(addedBytes)) throw unavailable();
  const id = randomUUID();
  await withExomemTransaction(async (tx) => {
    await tx`SELECT cell_id FROM exomem_cloud_cells WHERE cell_id = ${ctx.cell.cell_id} FOR UPDATE`;
    const unfinished = await tx`
      SELECT state, recovery_transaction_id FROM exomem_cloud_storage_operations
      WHERE subscription_ref = ${ctx.account.subscriptionRef} AND provider_environment = ${ctx.config.environment}
        AND state NOT IN ('applied', 'failed', 'superseded') FOR UPDATE
    `;
    if (
      unfinished.rows.some(
        (row) =>
          row.state !== "preview" &&
          !(
            row.state === "payment_required" &&
            cardReady &&
            row.recovery_transaction_id === recoveryId
          )
      )
    )
      throw conflict();
    const cell = await loadCell(ctx.account.userId, ctx.account.tenantId, tx);
    if (cell.observed_storage_pvc_uid !== ctx.cell.observed_storage_pvc_uid) throw conflict();
    const target = targetStorageGiB(cell, addedBytes);
    const paidAfter = safeNumber(cell.paid_storage_bytes) + addedBytes;
    if (!Number.isSafeInteger(paidAfter) || target > 2_147_483_647) throw unavailable();
    await tx`
      UPDATE exomem_cloud_storage_operations SET state = 'superseded', updated_at = now()
      WHERE subscription_ref = ${ctx.account.subscriptionRef} AND provider_environment = ${ctx.config.environment}
        AND (state = 'preview' OR (state = 'payment_required' AND recovery_transaction_id = ${cardReady ? recoveryId : null}))
    `;
    await tx`
      INSERT INTO exomem_cloud_storage_operations (
        id, tenant_id, cell_id, provider_environment, subscription_ref, state,
        baseline_fingerprint, baseline_items, target_items, storage_price_id, added_quantity,
        added_bytes, paid_bytes_after, target_storage_gib, pvc_uid, quote, quote_expires_at
      ) VALUES (
        ${id}::uuid, ${ctx.account.tenantId}::uuid, ${cell.cell_id}, ${ctx.config.environment}, ${ctx.account.subscriptionRef}, 'preview',
        ${storageSubscriptionFingerprint(current)}, ${JSON.stringify(storageItems(current))}::jsonb, ${JSON.stringify(items)}::jsonb,
        ${price.id}, ${quantity}, ${addedBytes}, ${paidAfter}, ${target}, ${cell.observed_storage_pvc_uid}, ${JSON.stringify(quote)}::jsonb,
        now() + interval '5 minutes'
      )
    `;
  });
  return publicOperation(await operation(ctx, id));
}

async function recordPaid(
  ctx: Context,
  op: Operation,
  payment: StoragePayment | null
): Promise<void> {
  await withExomemTransaction(async (tx) => {
    await tx`SELECT cell_id FROM exomem_cloud_cells WHERE cell_id = ${op.cell_id} FOR UPDATE`;
    const claimed = await tx`
      UPDATE exomem_cloud_storage_operations SET state = 'paid', payment_transaction_id = ${payment?.id ?? null},
        payment_facts = ${payment ? JSON.stringify({ due: payment.due, tax: payment.tax }) : null}::jsonb,
        provider_checked_at = now(), updated_at = now(), error_code = NULL
      WHERE id = ${op.id}::uuid AND state IN ('updating', 'unknown', 'payment_required') RETURNING id
    `;
    if (!claimed.rows.length) return;
    // The account may end after payment. Expand its kept disk without changing lifecycle or access.
    await loadCell(ctx.account.userId, ctx.account.tenantId, tx);
    await tx`
      UPDATE exomem_entitlements SET
        resource_limits = jsonb_set(resource_limits, '{storageBytes}', to_jsonb(
          (resource_limits->>'storageBytes')::bigint + GREATEST(0, ${op.paid_bytes_after}::bigint - paid_storage_bytes)
        )), paid_storage_bytes = GREATEST(paid_storage_bytes, ${op.paid_bytes_after}::bigint)
      WHERE tenant_id = ${ctx.account.tenantId}::uuid
    `;
    const changed = await tx`
      UPDATE exomem_cloud_cells SET storage_gib = GREATEST(storage_gib, ${op.target_storage_gib})
      WHERE cell_id = ${op.cell_id} AND desired_state <> 'deleted' RETURNING generation
    `;
    if (!changed.rows[0]) throw conflict();
    await tx`UPDATE exomem_cloud_storage_operations SET target_generation = ${changed.rows[0].generation} WHERE id = ${op.id}::uuid`;
  });
}

async function recover(ctx: Context, op: Operation): Promise<Operation> {
  if (op.state === "paid") {
    await executeExomemSql`
      UPDATE exomem_cloud_storage_operations AS op SET state = 'applied', updated_at = now(),
        applied_capacity_bytes = cell.observed_storage_capacity_bytes
      FROM exomem_cloud_cells AS cell
      WHERE op.id = ${op.id}::uuid AND op.state = 'paid' AND cell.cell_id = op.cell_id
        AND cell.observed_storage_pvc_uid = op.pvc_uid AND cell.observed_storage_pvc_version IS NOT NULL
        AND cell.observed_storage_capacity_bytes >= op.target_storage_gib::bigint * ${GIB}
        AND cell.observed_storage_generation >= op.target_generation
        AND cell.observed_storage_at >= op.confirmed_at
    `;
  } else if (
    op.confirmed_at &&
    (op.state === "updating" || op.state === "unknown" || op.state === "payment_required")
  ) {
    const current = await currentSubscription(ctx);
    if (
      sameStorageItems(storageItems(current), op.target_items) &&
      current.custom_data?.exomem_storage_operation === op.id
    ) {
      const paid = await findStoragePayment(
        current,
        op.id,
        op.storage_price_id,
        op.added_quantity,
        op.confirmed_at.toISOString(),
        ctx.transport
      );
      // A provider-confirmed zero charge requires no payment transaction; a browser event never supplies this proof.
      if (paid || op.quote.due.amount === "0") await recordPaid(ctx, op, paid);
    }
  }
  return operation(ctx, op.id);
}

async function confirm(ctx: Context, op: Operation): Promise<CloudStorageOperation> {
  if (op.state !== "preview") return publicOperation(await recover(ctx, op));
  canPurchase(ctx);
  if (op.quote_expires_at.getTime() <= Date.now()) throw conflict();
  const attemptId = randomUUID();
  const claimed = await executeExomemSql`
    UPDATE exomem_cloud_storage_operations AS op SET state = 'updating', confirmed_at = now(), attempt_id = ${attemptId}::uuid, updated_at = now()
    FROM exomem_tenants AS tenant, exomem_entitlements AS entitlement
    WHERE op.id = ${op.id}::uuid AND op.state = 'preview' AND op.quote_expires_at > now()
      AND tenant.id = op.tenant_id AND tenant.owner_user_id = ${ctx.account.userId}
      AND tenant.status NOT IN ('deleted', 'deletion_pending') AND tenant.desired_state <> 'deleted'
      AND entitlement.tenant_id = tenant.id AND entitlement.source_state = 'active'
      AND entitlement.manual_suspended_at IS NULL AND entitlement.provider_subscription_ref = op.subscription_ref
      AND entitlement.provider_environment = op.provider_environment
    RETURNING op.id
  `;
  if (!claimed.rows.length) return publicOperation(await operation(ctx, op.id));
  let submitted = false;
  try {
    // The durable claim survives a crash; this separate lock serializes complete item replacements.
    await withExomemTransaction(async (tx) => {
      await lockExomemSubscriptionUpdate(tx, ctx.account.tenantId);
      const bounded = {
        ...ctx,
        transport: paddleTransportUntil(AbortSignal.timeout(10_000), ctx.transport),
      };
      const current = await currentSubscription(bounded);
      if (storageSubscriptionFingerprint(current) !== op.baseline_fingerprint) throw conflict();
      const price = await readStorageCatalogue(op.storage_price_id, bounded.transport);
      if (
        price.custom_data.exomem_storage_bytes * op.added_quantity !== safeNumber(op.added_bytes) ||
        !sameStorageItems(storageTargetItems(current, price, op.added_quantity), op.target_items)
      )
        throw conflict();
      const quote = await previewStorageChange(current, op.target_items, bounded.transport);
      if (
        quote.due.currencyCode !== op.quote.due.currencyCode ||
        Number(quote.due.amount) > Number(op.quote.due.amount) ||
        quote.recurring.amount !== op.quote.recurring.amount ||
        quote.recurring.currencyCode !== op.quote.recurring.currencyCode
      )
        throw conflict();
      submitted = true;
      await updateStorageSubscription(current, op.target_items, op.id, bounded.transport);
    });
    await executeExomemSql`UPDATE exomem_cloud_storage_operations SET state = 'unknown', updated_at = now() WHERE id = ${op.id}::uuid AND attempt_id = ${attemptId}::uuid AND state = 'updating'`;
  } catch (error) {
    // Paddle documents this exact 400 code for a declined subscription charge.
    const declined =
      error instanceof ExomemBillingError &&
      error.providerCode === "subscription_payment_declined" &&
      error.providerStatus === 400;
    const refused =
      error instanceof ExomemBillingError &&
      error.providerStatus !== null &&
      error.providerStatus >= 400 &&
      error.providerStatus < 500 &&
      error.providerStatus !== 408;
    const state = declined ? "payment_required" : refused || !submitted ? "failed" : "unknown";
    await executeExomemSql`UPDATE exomem_cloud_storage_operations SET state = ${state}, error_code = ${declined ? "PAYMENT_DECLINED" : "UPDATE_UNRESOLVED"}, updated_at = now() WHERE id = ${op.id}::uuid AND attempt_id = ${attemptId}::uuid AND state = 'updating'`;
    if (state === "unknown") return publicOperation(await operation(ctx, op.id));
  }
  return publicOperation(await recover(ctx, await operation(ctx, op.id)));
}

export async function handleCloudStorage(
  userId: string,
  tenantId: string,
  request: z.infer<typeof storageRequest>,
  deps: Dependencies = {}
) {
  const ctx = await context(userId, tenantId, deps);
  if (request.action !== "inspect" && request.tenantBinding !== tenantId)
    throw exomemErrors.entitlementDenied();
  if (request.action === "inspect") {
    const rows = await executeExomemSql`
      SELECT id FROM exomem_cloud_storage_operations WHERE tenant_id = ${tenantId}::uuid
        AND subscription_ref = ${ctx.account.subscriptionRef} AND provider_environment = ${ctx.config.environment}
        AND state NOT IN ('applied', 'failed', 'superseded') ORDER BY created_at DESC LIMIT 1
    `;
    const pending = rows.rows[0]
      ? publicOperation(await recover(ctx, await operation(ctx, String(rows.rows[0].id))))
      : null;
    canPurchase(ctx);
    const priceId = deps.priceId ?? process.env.EXOMEM_PADDLE_STORAGE_PRICE_ID;
    if (!priceId) throw unavailable();
    const price = await readStorageCatalogue(priceId, ctx.transport);
    return {
      tenantBinding: ctx.account.tenantId,
      ownerEmail: ctx.cell.owner_email,
      operation: pending,
      packs: storageQuantities(await currentSubscription(ctx), price).map((quantity) => {
        const addedBytes = quantity * price.custom_data.exomem_storage_bytes;
        return { quantity, addedBytes, targetBytes: targetStorageGiB(ctx.cell, addedBytes) * GIB };
      }),
    };
  }
  if (request.action === "preview")
    return { operation: await preview(ctx, request.quantity, deps) };
  const op = await operation(ctx, request.operationId);
  if (request.action === "confirm") return { operation: await confirm(ctx, op) };
  if (request.action === "payment-method") {
    if (op.state !== "payment_required") throw conflict();
    await withExomemTransaction(async (tx) => {
      await tx`SELECT id FROM exomem_cloud_storage_operations WHERE id = ${op.id}::uuid FOR UPDATE`;
      const current = await operation(ctx, op.id, tx);
      if (current.state !== "payment_required") throw conflict();
      if (!current.recovery_transaction_id) {
        const id = await storagePaymentMethodTransaction(
          await currentSubscription(ctx),
          ctx.transport
        );
        await tx`UPDATE exomem_cloud_storage_operations SET recovery_transaction_id = ${id}, updated_at = now() WHERE id = ${op.id}::uuid AND state = 'payment_required'`;
      }
    });
    return { operation: publicOperation(await operation(ctx, op.id)) };
  }
  return { operation: publicOperation(await recover(ctx, op)) };
}
