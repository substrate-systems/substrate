import type { NextRequest } from "next/server";
import { completeEmailChangeRequest } from "../capability-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: NextRequest) => completeEmailChangeRequest(request, "confirm");
