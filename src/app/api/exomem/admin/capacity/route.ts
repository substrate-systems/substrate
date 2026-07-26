import { NextRequest, NextResponse } from "next/server";
import {
  configureCapacityPoolAtomic,
  getCapacityPoolStatus,
} from "@/lib/exomem-hosted/capacity-store";
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

const CAPACITY_POOL = "exomem-hosted-alpha";
const capacityKeys = [
  "storageCapacityBytes",
  "runtimeCapacitySlots",
  "provisionReservationCapacity",
  "provisionClaimCapacity",
] as const;

function capacityValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const capacity = await getCapacityPoolStatus();
    if (!capacity) throw exomemErrors.invalidRequest();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, capacity, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const values = capacityKeys.map((key) => capacityValue(body[key]));
    if (values.some((value) => value === null)) throw exomemErrors.invalidRequest();
    const configured = await configureCapacityPoolAtomic({
      poolKey: CAPACITY_POOL,
      storageCapacityBytes: values[0]!,
      runtimeCapacitySlots: values[1]!,
      provisionReservationCapacity: values[2]!,
      provisionClaimCapacity: values[3]!,
    });
    if (!configured) throw exomemErrors.invalidRequest();
    const capacity = await getCapacityPoolStatus();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, capacity, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
