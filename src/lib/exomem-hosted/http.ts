import { randomUUID } from "node:crypto";
import { ExomemHostedError, safeErrorResponse } from "./errors";
import {
  buildOperationalEvent,
  emitOperationalEvent,
  type OperationalEvent,
} from "./observability";

export function newRequestId(): string {
  return randomUUID();
}

export function emitAccessEvent(
  input: Omit<OperationalEvent, "timestamp"> & Record<string, unknown>
): void {
  emitOperationalEvent(buildOperationalEvent(input));
}

export function accessErrorResponse(input: { error: unknown; event: string; requestId: string }) {
  const errorCode = input.error instanceof ExomemHostedError ? input.error.code : "INTERNAL_ERROR";
  emitAccessEvent({
    event: input.event,
    outcome: "denied",
    requestId: input.requestId,
    errorCode,
  });
  return safeErrorResponse(input.error, input.requestId);
}
