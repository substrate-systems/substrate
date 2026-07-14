import { NextRequest, NextResponse } from "next/server";
import { safeErrorResponse, exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  gatewayLimits,
  hasForbiddenGatewayHeaders,
  hasReservedSelector,
  routeExomemCommand,
} from "@/lib/exomem-hosted/gateway";
import { newRequestId } from "@/lib/exomem-hosted/http";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBoundedJson(request: NextRequest, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) throw exomemErrors.invalidRequest();
    if (declared > maxBytes) throw exomemErrors.requestTooLarge();
  }
  if (!request.body) throw exomemErrors.invalidRequest();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    received += next.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw exomemErrors.requestTooLarge();
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(received);
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ command: string }> }
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    if (request.nextUrl.search || hasForbiddenGatewayHeaders(request.headers)) {
      throw exomemErrors.selectorRejected();
    }
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const value = await readBoundedJson(request, gatewayLimits.commandBytes);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw exomemErrors.invalidRequest();
    }
    const args = value as Record<string, unknown>;
    if (hasReservedSelector(args)) throw exomemErrors.selectorRejected();
    const { command } = await context.params;
    const result = await routeExomemCommand({
      session,
      commandName: command,
      args,
      idempotencyKey: request.headers.get("idempotency-key"),
      requestId,
    });
    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store, private",
        "x-exomem-request-id": requestId,
      },
    });
  } catch (error) {
    const response = safeErrorResponse(error, requestId);
    response.headers.set("cache-control", "no-store, private");
    response.headers.set("x-exomem-request-id", requestId);
    return response;
  }
}
