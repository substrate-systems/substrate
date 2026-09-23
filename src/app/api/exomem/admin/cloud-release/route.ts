import { NextRequest, NextResponse } from "next/server";
import {
  clearPausedCloudRollout,
  getCloudOperatorView,
  InvalidCloudCellImageError,
  setCloudCellDesiredImage,
  setCloudReleaseImage,
} from "@/lib/exomem-hosted/cloud-release";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Design D5's owner-only release route. Three independent actions, each
// touching only the one column that action names — a request may combine
// them (e.g. set the fleet image and clear a paused rollout together), but
// each is validated and applied on its own.
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const view = await getCloudOperatorView();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, view, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);

    const hasCellImage = "cellImage" in body;
    const hasClearRolloutPause = "clearRolloutPause" in body;
    const hasCellDesiredImage = "cellId" in body || "cellDesiredImage" in body;
    if (!hasCellImage && !hasClearRolloutPause && !hasCellDesiredImage) {
      throw exomemErrors.invalidRequest();
    }

    // Security review finding 10: an image that isn't
    // <configured repository>@sha256:<64 lowercase hex> is a 400
    // invalid_request, not an internal error -- setCloudReleaseImage and
    // setCloudCellDesiredImage both enforce this themselves
    // (assertValidCloudCellImage), so this only remaps the error code.
    try {
      if (hasCellImage) {
        const image = nonEmptyString(body.cellImage);
        if (!image) throw exomemErrors.invalidRequest();
        await setCloudReleaseImage(image);
      }

      if (hasClearRolloutPause) {
        if (body.clearRolloutPause !== true) throw exomemErrors.invalidRequest();
        await clearPausedCloudRollout();
      }

      if (hasCellDesiredImage) {
        const cellId = nonEmptyString(body.cellId);
        if (!cellId) throw exomemErrors.invalidRequest();
        // Present but not a non-empty string (e.g. explicit `null`) clears the
        // per-cell override back to the fleet default.
        const cellDesiredImage =
          "cellDesiredImage" in body && body.cellDesiredImage !== null
            ? nonEmptyString(body.cellDesiredImage)
            : null;
        if ("cellDesiredImage" in body && body.cellDesiredImage !== null && !cellDesiredImage) {
          throw exomemErrors.invalidRequest();
        }
        const applied = await setCloudCellDesiredImage(cellId, cellDesiredImage);
        if (!applied) throw exomemErrors.invalidRequest();
      }
    } catch (error) {
      if (error instanceof InvalidCloudCellImageError) throw exomemErrors.invalidRequest();
      throw error;
    }

    const view = await getCloudOperatorView();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, view, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
