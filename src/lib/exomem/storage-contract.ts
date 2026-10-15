import { z } from "zod";
import { isExomemMoney } from "./money";

const money = z.object({ amount: z.string(), currencyCode: z.string() }).refine(isExomemMoney);
const quote = z.object({
  due: money,
  tax: money,
  recurring: money,
  nextBilledAt: z.string().nullable(),
  observedAt: z.string(),
});

// Migration 0071 fixes the operation states; the server and browser share this wire schema.
const storageOperation = z.object({
  id: z.uuid(),
  state: z.enum([
    "preview",
    "updating",
    "unknown",
    "payment_required",
    "paid",
    "applied",
    "failed",
    "superseded",
  ]),
  addedBytes: z.number().int().positive().safe(),
  targetBytes: z.number().int().positive().safe(),
  capacityBytes: z.number().int().positive().safe().nullable(),
  quote,
  quoteExpiresAt: z.iso.datetime(),
  recoveryTransactionId: z.string().nullable(),
});
export type CloudStorageOperation = z.infer<typeof storageOperation>;

export const storageReply = z.object({
  success: z.literal(true),
  operation: storageOperation.nullable(),
  tenantBinding: z.uuid().optional(),
  ownerEmail: z.string().optional(),
  packs: z
    .array(
      z.object({
        quantity: z.number().int().positive(),
        addedBytes: z.number().int().positive().safe(),
        targetBytes: z.number().int().positive().safe(),
      })
    )
    .optional(),
});

export const storageRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z
    .object({
      action: z.literal("preview"),
      tenantBinding: z.uuid(),
      quantity: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ action: z.literal("confirm"), tenantBinding: z.uuid(), operationId: z.uuid() })
    .strict(),
  z
    .object({ action: z.literal("status"), tenantBinding: z.uuid(), operationId: z.uuid() })
    .strict(),
  z
    .object({ action: z.literal("payment-method"), tenantBinding: z.uuid(), operationId: z.uuid() })
    .strict(),
]);
