import { NextRequest, NextResponse } from "next/server";
import { ExomemHostedError, safeErrorResponse, exomemErrors } from "@/lib/exomem-hosted/errors";
import { hasForbiddenGatewayHeaders, normalizeIdempotencyKey } from "@/lib/exomem-hosted/gateway";
import {
  createBoundTransfer,
  finishBoundTransfer,
  MULTIPART_OVERHEAD_BYTES,
  privateTransferHeaders,
  readBoundedTransferJson,
  type BoundTransfer,
} from "@/lib/exomem-hosted/transfers";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TRANSFER_IDLE_TIMEOUT_MS = 30_000;

function boundedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  onActivity: () => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        onActivity();
        controller.close();
        return;
      }
      onActivity();
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        controller.error(exomemErrors.requestTooLarge());
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let requestId: string | undefined;
  let transfer: BoundTransfer | undefined;
  try {
    if (request.nextUrl.search || hasForbiddenGatewayHeaders(request.headers)) {
      throw exomemErrors.selectorRejected();
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw exomemErrors.invalidRequest();
    }
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const idempotencyKey = normalizeIdempotencyKey(request.headers.get("idempotency-key"));
    transfer = await createBoundTransfer({ session, operation: "upload" });
    requestId = transfer.requestId;
    const maxBodyBytes = transfer.maxBytes + MULTIPART_OVERHEAD_BYTES;
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const parsed = Number(contentLength);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw exomemErrors.invalidRequest();
      }
      if (parsed > maxBodyBytes) throw exomemErrors.requestTooLarge();
    }
    if (!request.body) throw exomemErrors.invalidRequest();
    const endpoint = new URL(
      "private/exomem/v1/upload",
      `${transfer.target.endpoint.toString().replace(/\/$/, "")}/`
    );
    let cellResponse: Response;
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdleTimeout = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), TRANSFER_IDLE_TIMEOUT_MS);
    };
    try {
      resetIdleTimeout();
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          ...privateTransferHeaders(transfer),
          "idempotency-key": idempotencyKey,
          "content-type": contentType,
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
        body: boundedBody(request.body, maxBodyBytes, resetIdleTimeout),
        duplex: "half",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      };
      cellResponse = await fetch(endpoint, init);
    } catch {
      await finishBoundTransfer(transfer, "CELL_UNAVAILABLE").catch(() => undefined);
      throw exomemErrors.cellUnavailable();
    } finally {
      clearTimeout(idleTimer!);
    }
    const envelope = await readBoundedTransferJson(
      cellResponse,
      MAX_RESPONSE_BYTES,
      TRANSFER_IDLE_TIMEOUT_MS
    );
    const error =
      envelope.success === false &&
      envelope.error &&
      typeof envelope.error === "object" &&
      !Array.isArray(envelope.error)
        ? (envelope.error as Record<string, unknown>)
        : null;
    const outcomeCode =
      cellResponse.ok && envelope.success === true
        ? "OK"
        : typeof error?.code === "string"
          ? error.code
          : "TRANSFER_FAILED";
    await finishBoundTransfer(transfer, outcomeCode).catch(() => undefined);
    return NextResponse.json(envelope, {
      status: cellResponse.status,
      headers: {
        "cache-control": "no-store, private",
        "x-exomem-request-id": transfer.requestId,
      },
    });
  } catch (error) {
    if (transfer) {
      const outcome = error instanceof ExomemHostedError ? error.code : "TRANSFER_FAILED";
      await finishBoundTransfer(transfer, outcome).catch(() => undefined);
    }
    const response = safeErrorResponse(error, requestId);
    response.headers.set("cache-control", "no-store, private");
    if (requestId) response.headers.set("x-exomem-request-id", requestId);
    return response;
  }
}
