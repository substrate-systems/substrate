import { handleHostedMcpRequest } from "@/lib/exomem-hosted/mcp";
import { emitOperationalEvent } from "@/lib/exomem-hosted/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mcpRequest(request: Request | undefined, method: string): Request {
  return request ?? new Request("https://substratesystems.io/api/exomem/mcp/v1", { method });
}

export async function GET(request?: Request): Promise<Response> {
  return handleHostedMcpRequest(mcpRequest(request, "GET"), { telemetry: emitOperationalEvent });
}

export async function POST(request?: Request): Promise<Response> {
  return handleHostedMcpRequest(mcpRequest(request, "POST"), { telemetry: emitOperationalEvent });
}

export async function DELETE(request?: Request): Promise<Response> {
  return handleHostedMcpRequest(mcpRequest(request, "DELETE"), { telemetry: emitOperationalEvent });
}
