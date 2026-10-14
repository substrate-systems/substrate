import type { NextRequest } from "next/server";
import { runEmailHealthCheck } from "@/lib/exomem-hosted/functional-health";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  if (!verifyHostedSchedulerAuth(request).ok) {
    return Response.json({ ok: false }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const ok = await runEmailHealthCheck();
  return Response.json(
    { ok },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
