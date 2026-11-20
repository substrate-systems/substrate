import { NextResponse } from "next/server";
import { getCloudRolloutView } from "@/lib/exomem-hosted/cloud-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The release is public (it is a tag on the public repository), so the answer is shared
// through the CDN for a minute: every signed-in page asks, and none of them should cost a query.
const CACHE = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET(): Promise<NextResponse> {
  try {
    const { release } = await getCloudRolloutView();
    return NextResponse.json(
      release === null ? { state: "unknown" } : { state: "known", release },
      { headers: { "cache-control": CACHE } }
    );
  } catch {
    // A failed read is its own state and is never cached as "unknown".
    return NextResponse.json(
      { state: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
