import { NextRequest, NextResponse } from "next/server";
import {
  capabilityEndpointNotFoundResponse,
  safeErrorResponse,
} from "@/lib/exomem-hosted/next-error-response";
import { emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";
import { alertEndpointNotFound, verifyAlertToken } from "@/lib/exomem-hosted/alert-receiver";
import { readCellDeletionSet } from "@/lib/exomem-hosted/cloud-deletion-grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves the key watcher's deletion set (automate-cell-storage-deletion D4).
 *
 * The watcher runs outside the cluster and reads this on each pass; the URL's
 * last segment is its own receiver capability, verified by the same digest
 * ring as the alerts route. The scheduler capability, any other token and an
 * unconfigured ring all get the alerts route's 404, so this route adds no new
 * way to distinguish credentials.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { token } = await params;
    const credential = verifyAlertToken(token);
    if (credential !== "key-watcher") {
      // The scheduler capability is a valid credential that must still learn
      // nothing from this endpoint, so it gets the same 404 as a bad token.
      throw alertEndpointNotFound();
    }
    const cells = await readCellDeletionSet();
    emitAccessEvent({
      event: "exomem.cell-deletions.read",
      outcome: "succeeded",
      requestId,
    });
    return NextResponse.json(
      {
        schema_version: 1,
        cells: cells.map((cell) => ({
          cell_id: cell.cellId,
          iat: cell.iat,
          purge_after: cell.purgeAfter,
          stopped_at: cell.stoppedAt,
        })),
      },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    // A refusal is the shared 404; anything else is a read failure, which the
    // watcher reports as DELETIONS_UNKNOWN rather than acting on a partial set.
    const denied = error instanceof ExomemHostedError && error.status === 404;
    emitAccessEvent({
      event: denied ? "exomem.cell-deletions.denied" : "exomem.cell-deletions.failed",
      outcome: denied ? "denied" : "failed",
      requestId,
      errorCode: denied ? error.code : "INTERNAL_ERROR",
    });
    return safeErrorResponse(error, requestId);
  }
}

/** The route matches any single segment, so without these the framework would
 * answer 405 with an `Allow` header for a wrong method and confirm the endpoint
 * exists to an unauthenticated prober. */
function methodNotFound(): NextResponse {
  return capabilityEndpointNotFoundResponse();
}

export const POST = methodNotFound;
export const PUT = methodNotFound;
export const PATCH = methodNotFound;
export const DELETE = methodNotFound;
export const OPTIONS = methodNotFound;
