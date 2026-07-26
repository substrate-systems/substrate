import { handleHostedMcpRequest } from "@/lib/exomem-hosted/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mcpRequest(request: Request | undefined, method: string): Request {
  return request ?? new Request("https://substratesystems.io/api/exomem/mcp/v1", { method });
}

export async function GET(request?: Request): Promise<Response> {
  return handleHostedMcpRequest(mcpRequest(request, "GET"));
}

export async function POST(request?: Request): Promise<Response> {
  return handleHostedMcpRequest(mcpRequest(request, "POST"));
}

export async function DELETE(request?: Request): Promise<Response> {
  return handleHostedMcpRequest(mcpRequest(request, "DELETE"));
}
