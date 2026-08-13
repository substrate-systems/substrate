import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public self-serve admission is deferred during the friends-only v1 alpha. */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "self_serve_deferred" },
    { status: 410, headers: { "cache-control": "no-store" } }
  );
}
