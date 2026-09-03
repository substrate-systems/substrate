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
  const safe = input.error instanceof ExomemHostedError ? input.error : null;
  emitAccessEvent({
    // The denial log is where an operator learns why admission refused; the
    // response cannot say. `buildOperationalEvent` keeps only the fields it
    // knows, so a detail it has no field for is dropped rather than emitted.
    // Spread first, so a detail can never displace the four fields this call
    // owns — `outcome` above all, whose only legal values are fixed, and which
    // would turn this refusal into an unhandled 500 if it were overwritten.
    // `OperatorErrorDetail` already closes the key space; this is the ordering
    // that holds even for a caller who got past it.
    ...safe?.operatorDetail,
    event: input.event,
    outcome: "denied",
    requestId: input.requestId,
    errorCode: safe?.code ?? "INTERNAL_ERROR",
  });
  return safeErrorResponse(input.error, input.requestId);
}
