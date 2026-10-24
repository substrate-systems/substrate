import { randomUUID } from "node:crypto";
import { ExomemHostedError } from "./errors";
import { safeErrorResponse } from "./next-error-response";
import {
  buildOperationalEvent,
  emitOperationalEvent,
  type OperationalEvent,
} from "./observability";

/** Headers for an owner's own data: no shared cache may keep it and no crawler may index it. */
export const PRIVATE_NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
};

export function newRequestId(): string {
  return randomUUID();
}

// The reader lives in a module with no Next.js import, so the gateway can bound a web answer with it.
export { readBoundedJsonRequest } from "./bounded-json";

export function emitAccessEvent(
  input: Omit<OperationalEvent, "timestamp"> & Record<string, unknown>
): void {
  emitOperationalEvent(buildOperationalEvent(input));
}

export function accessErrorResponse(input: { error: unknown; event: string; requestId: string }) {
  const safe = input.error instanceof ExomemHostedError ? input.error : null;
  emitAccessEvent({
    event: input.event,
    outcome: "denied",
    requestId: input.requestId,
    errorCode: safe?.code ?? "INTERNAL_ERROR",
  });
  return safeErrorResponse(input.error, input.requestId);
}
