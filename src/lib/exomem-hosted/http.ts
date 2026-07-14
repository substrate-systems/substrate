import { randomUUID } from "node:crypto";
import { ExomemHostedError, exomemErrors, safeErrorResponse } from "./errors";
import {
  buildOperationalEvent,
  emitOperationalEvent,
  type OperationalEvent,
} from "./observability";

export function newRequestId(): string {
  return randomUUID();
}

export async function readBoundedJsonRequest(request: Request, maxBytes: number): Promise<unknown> {
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw) {
    if (!/^\d+$/.test(declaredRaw)) throw exomemErrors.invalidRequest();
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw exomemErrors.requestTooLarge();
    }
  }
  if (!request.body) throw exomemErrors.invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw exomemErrors.requestTooLarge();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw exomemErrors.invalidRequest();
  }
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
