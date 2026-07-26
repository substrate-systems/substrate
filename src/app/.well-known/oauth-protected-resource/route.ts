import { GET as canonicalGet } from "./api/exomem/mcp/v1/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Compatibility alias for hosts that do not append the resource path. */
export const GET = canonicalGet;
