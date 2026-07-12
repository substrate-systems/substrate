import { NextRequest, NextResponse } from "next/server";
import { safeErrorResponse, exomemErrors } from "@/lib/exomem-hosted/errors";
import { hasForbiddenGatewayHeaders } from "@/lib/exomem-hosted/gateway";
import {
  createBoundTransfer,
  finishBoundTransfer,
  privateTransferHeaders,
  readBoundedTransferJson,
} from "@/lib/exomem-hosted/transfers";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ERROR_BYTES = 1024 * 1024;
const TRANSFER_IDLE_TIMEOUT_MS = 30_000;

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onTimeout: () => void
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error("transfer idle"));
        }, TRANSFER_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let requestId: string | undefined;
  try {
    if (hasForbiddenGatewayHeaders(request.headers)) {
      throw exomemErrors.selectorRejected();
    }
    if (request.nextUrl.search) throw exomemErrors.invalidRequest();
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw exomemErrors.invalidRequest();
    }
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (typeof body.path !== "string" || !body.path.trim() || Object.keys(body).length !== 1) {
      throw exomemErrors.invalidRequest();
    }
    const transfer = await createBoundTransfer({ session, operation: "download" });
    requestId = transfer.requestId;
    const endpoint = new URL(
      "private/exomem/v1/download",
      `${transfer.target.endpoint.toString().replace(/\/$/, "")}/`
    );
    let cellResponse: Response;
    const upstreamController = new AbortController();
    const connectionTimer = setTimeout(() => upstreamController.abort(), TRANSFER_IDLE_TIMEOUT_MS);
    try {
      cellResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...privateTransferHeaders(transfer),
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: body.path }),
        cache: "no-store",
        redirect: "error",
        signal: upstreamController.signal,
      });
    } catch {
      await finishBoundTransfer(transfer, "CELL_UNAVAILABLE").catch(() => undefined);
      throw exomemErrors.cellUnavailable();
    } finally {
      clearTimeout(connectionTimer);
    }
    if (!cellResponse.ok) {
      const envelope = await readBoundedTransferJson(
        cellResponse,
        MAX_ERROR_BYTES,
        TRANSFER_IDLE_TIMEOUT_MS
      );
      const code =
        envelope.error &&
        typeof envelope.error === "object" &&
        !Array.isArray(envelope.error) &&
        typeof (envelope.error as Record<string, unknown>).code === "string"
          ? String((envelope.error as Record<string, unknown>).code)
          : "TRANSFER_FAILED";
      await finishBoundTransfer(transfer, code).catch(() => undefined);
      return NextResponse.json(envelope, {
        status: cellResponse.status,
        headers: {
          "cache-control": "no-store, private",
          "x-exomem-request-id": transfer.requestId,
        },
      });
    }
    const lengthHeader = cellResponse.headers.get("content-length");
    const length = lengthHeader ? Number(lengthHeader) : null;
    if (
      length !== null &&
      (!Number.isSafeInteger(length) || length < 0 || length > transfer.maxBytes)
    ) {
      await cellResponse.body?.cancel();
      await finishBoundTransfer(transfer, "TOO_LARGE").catch(() => undefined);
      throw exomemErrors.requestTooLarge();
    }
    if (!cellResponse.body) throw exomemErrors.cellResponseInvalid();
    const reader = cellResponse.body.getReader();
    let received = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await readWithIdleTimeout(reader, () => upstreamController.abort());
          if (next.done) {
            await finishBoundTransfer(transfer, "OK").catch(() => undefined);
            controller.close();
            return;
          }
          received += next.value.byteLength;
          if (received > transfer.maxBytes) {
            await reader.cancel();
            await finishBoundTransfer(transfer, "TOO_LARGE").catch(() => undefined);
            controller.error(exomemErrors.requestTooLarge());
            return;
          }
          controller.enqueue(next.value);
        } catch {
          upstreamController.abort();
          await reader.cancel().catch(() => undefined);
          await finishBoundTransfer(transfer, "TRANSFER_FAILED").catch(() => undefined);
          controller.error(exomemErrors.cellUnavailable());
        }
      },
      async cancel(reason) {
        upstreamController.abort();
        await reader.cancel(reason);
        await finishBoundTransfer(transfer, "TRANSFER_CANCELLED").catch(() => undefined);
      },
    });
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        ...(lengthHeader ? { "content-length": lengthHeader } : {}),
        ...(cellResponse.headers.get("content-disposition")
          ? {
              "content-disposition": String(cellResponse.headers.get("content-disposition")),
            }
          : {}),
        "cache-control": "no-store, private",
        "x-exomem-request-id": transfer.requestId,
      },
    });
  } catch (error) {
    const response = safeErrorResponse(error, requestId);
    response.headers.set("cache-control", "no-store, private");
    if (requestId) response.headers.set("x-exomem-request-id", requestId);
    return response;
  }
}
