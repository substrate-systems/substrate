import { NextRequest, NextResponse } from "next/server";
import { exomemCloudMcpUrlOrNull } from "@/lib/exomem-hosted/cloud-config";
import {
  issueCloudServiceCredentialAtomic,
  listCloudServiceCredentials,
  revokeCloudServiceCredentialAtomic,
} from "@/lib/exomem-hosted/cloud-service-credentials";
import { SERVICE_CREDENTIAL_PRINCIPAL_FORMAT } from "@/lib/exomem-hosted/service-credential-format";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Selector = { tenantId: string } | { ownerEmail: string };

// A tenant is selected by its id or its owner's email, never both: two
// selectors in one request is an operator mistake the route refuses to guess
// through, because each resolves a tenant the other may not name.
function tenantSelector(record: Record<string, unknown>): Selector | null {
  const tenantId = record.tenantId;
  const email = record.email;
  if (typeof tenantId === "string" && email === undefined) {
    return UUID.test(tenantId) ? { tenantId } : null;
  }
  if (tenantId === undefined && typeof email === "string") {
    const trimmed = email.trim();
    return trimmed.length > 0 && trimmed.length <= 320 ? { ownerEmail: trimmed } : null;
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const selector = tenantSelector(body);
    const principal = body.principal;
    if (!selector || typeof principal !== "string" || !SERVICE_CREDENTIAL_PRINCIPAL_FORMAT.test(principal)) {
      throw exomemErrors.invalidRequest();
    }
    const issued = await issueCloudServiceCredentialAtomic({
      ...selector,
      principal,
      operatorPrincipalDigest: operator.principalDigest,
    });
    operatorSuccessEvent(requestId);
    // The only place the secret ever appears: once, in this response (spec:
    // "The secret is shown once"). no-store and no-referrer keep it out of
    // caches and Referer headers; it is in no list response, log or error.
    return NextResponse.json(
      {
        success: true,
        credentialId: issued.credentialId,
        tenantId: issued.tenantId,
        principal: issued.principal,
        cellId: issued.cellId,
        cloudMcpUrl: exomemCloudMcpUrlOrNull(),
        secret: issued.secret,
        requestId,
      },
      { status: 201, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const params = new URL(request.url).searchParams;
    const selector = tenantSelector({
      tenantId: params.get("tenantId") ?? undefined,
      email: params.get("email") ?? undefined,
    });
    if (!selector) throw exomemErrors.invalidRequest();
    const credentials = await listCloudServiceCredentials(selector);
    if (!credentials) throw exomemErrors.invalidRequest();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, credentials, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const credentialId = body.credentialId;
    if (typeof credentialId !== "string" || !UUID.test(credentialId)) {
      throw exomemErrors.invalidRequest();
    }
    const revoked = await revokeCloudServiceCredentialAtomic({
      credentialId,
      operatorPrincipalDigest: operator.principalDigest,
    });
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, revoked, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
