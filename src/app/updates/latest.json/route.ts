import { NextResponse } from "next/server";
import { captureServer, ServerEvent } from "@/lib/analytics-server";

export const runtime = "nodejs";
export const revalidate = 300;

/**
 * Aggregate count of update checks, carrying no identifier of any kind.
 *
 * The local product's no-telemetry commitment is inviolable, so this is the one
 * seam where an innocuous count could quietly become install telemetry. The
 * guarantee is structural rather than disciplinary: `GET` takes no `Request`
 * parameter, so no header, cookie, IP or user agent is even in scope to attach.
 * `route.test.ts` pins both that signature and the absence of any identifier in
 * the captured properties.
 *
 * `outcome` is included because a manifest that stops resolving breaks updates
 * silently, and "checks are happening but all failing" must be distinguishable
 * from "nobody is checking".
 */
async function countUpdateCheck(outcome: "served" | "unavailable"): Promise<void> {
  await captureServer({
    event: ServerEvent.UpdateChecked,
    distinctId: null,
    properties: { outcome },
  });
}

const UPSTREAM_URL =
  "https://github.com/Artexis10/endstate-gui/releases/latest/download/latest.json";

const CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=60";

export async function GET(): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      next: { revalidate: 300 },
      redirect: "follow",
    });
  } catch (err) {
    console.error("[updates/latest.json] upstream fetch threw", {
      url: UPSTREAM_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    await countUpdateCheck("unavailable");
    return NextResponse.json({ error: "manifest_unavailable" }, { status: 503 });
  }

  if (!upstream.ok) {
    console.error("[updates/latest.json] upstream returned non-2xx", {
      url: UPSTREAM_URL,
      status: upstream.status,
    });
    await countUpdateCheck("unavailable");
    return NextResponse.json({ error: "manifest_unavailable" }, { status: 503 });
  }

  let manifest: unknown;
  try {
    manifest = await upstream.json();
  } catch (err) {
    console.error("[updates/latest.json] upstream returned invalid JSON", {
      url: UPSTREAM_URL,
      error: err instanceof Error ? err.message : String(err),
    });
    await countUpdateCheck("unavailable");
    return NextResponse.json({ error: "manifest_unavailable" }, { status: 503 });
  }

  await countUpdateCheck("served");
  return NextResponse.json(manifest, {
    status: 200,
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}
