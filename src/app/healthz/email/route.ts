import { functionalHealthResponse } from "@/lib/exomem-hosted/functional-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return functionalHealthResponse("email");
}
