import { NextRequest, NextResponse } from "next/server";
import {
  applyCloudReleaseChanges,
  CloudImageSeenError,
  CloudReleaseCellNotFoundError,
  CloudReleaseOlderError,
  getCloudOperatorView,
  getCloudRolloutView,
  InvalidCloudCellImageError,
  InvalidCloudReleaseTagError,
  type CloudReleaseChanges,
} from "@/lib/exomem-hosted/cloud-release";
import { ExomemHostedError, exomemErrors } from "@/lib/exomem-hosted/errors";
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
//
// automate-cloud-releases D1 narrows the deploy token: it may PUT `cellImage`
// with its `release` and nothing else, and it may not read this full view,
// which names every cell and tenant. It reads `./rollout` instead.
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const DEPLOY_FIELDS = ["cellImage", "release"];

function deployScopeDenied(): ExomemHostedError {
  return new ExomemHostedError({
    code: "OPERATOR_SCOPE_DENIED",
    status: 403,
    message: "the deploy token may only set the release image",
  });
}

/** D1: the release automation treats both codes as "the fleet already has this or newer". */
function releaseRefusal(error: CloudImageSeenError | CloudReleaseOlderError): ExomemHostedError {
  return new ExomemHostedError({ code: error.code, status: 409, message: error.message });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read", "admin");
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
    const operator = await requireRateLimitedExomemOperator(request, "mutation", "deploy");
    const body = await readOperatorJsonRecord(request);
    if (operator.principal === "deploy") {
      const fields = Object.keys(body);
      if (
        fields.length !== DEPLOY_FIELDS.length ||
        !DEPLOY_FIELDS.every((field) => fields.includes(field))
      ) {
        throw deployScopeDenied();
      }
    }

    const hasCellImage = "cellImage" in body;
    const hasClearRolloutPause = "clearRolloutPause" in body;
    const hasCellDesiredImage = "cellId" in body || "cellDesiredImage" in body;
    if (!hasCellImage && !hasClearRolloutPause && !hasCellDesiredImage) {
      throw exomemErrors.invalidRequest();
    }

    // D5: every value is parsed and validated before anything is written,
    // and applyCloudReleaseChanges writes them in one transaction, so a
    // partly invalid request changes nothing. Security review finding 10: an
    // image that isn't <configured repository>@sha256:<64 lowercase hex> is a
    // 400 invalid_request, not an internal error.
    const changes: CloudReleaseChanges = {};
    if (hasCellImage) {
      const image = nonEmptyString(body.cellImage);
      if (!image) throw exomemErrors.invalidRequest();
      changes.cellImage = image;
    }
    if ("release" in body) {
      const release = nonEmptyString(body.release);
      if (!release || !hasCellImage) throw exomemErrors.invalidRequest();
      changes.release = release;
    }
    if (hasClearRolloutPause) {
      if (body.clearRolloutPause !== true) throw exomemErrors.invalidRequest();
      changes.clearRolloutPause = true;
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
      changes.cellDesiredImage = { cellId, image: cellDesiredImage };
    }
    try {
      await applyCloudReleaseChanges(changes, operator.principal);
    } catch (error) {
      if (
        error instanceof InvalidCloudCellImageError ||
        error instanceof InvalidCloudReleaseTagError ||
        error instanceof CloudReleaseCellNotFoundError
      ) {
        throw exomemErrors.invalidRequest();
      }
      if (error instanceof CloudImageSeenError || error instanceof CloudReleaseOlderError) {
        throw releaseRefusal(error);
      }
      throw error;
    }

    const view =
      operator.principal === "deploy" ? await getCloudRolloutView() : await getCloudOperatorView();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, view, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
