import { NextResponse } from "next/server";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/exomem-hosted/http";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { listOwnerApps } from "@/lib/exomem-hosted/owner-apps";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    return NextResponse.json(await listOwnerApps(session), { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS))
      response.headers.set(name, value);
    return response;
  }
}
