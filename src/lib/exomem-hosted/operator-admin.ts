import { exomemErrors } from "./errors";
import { newRequestId, readBoundedJsonRequest } from "./http";
import { requireExomemOperator } from "./operator-auth";
import { emitOperatorControlSuccess, operatorControlErrorResponse } from "./operator-observability";
import { clientAddressKey, EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";

export const OPERATOR_BODY_MAX_BYTES = 16 * 1024;

export async function requireRateLimitedExomemOperator(
  request: Request,
  operation: "read" | "mutation" = "mutation"
) {
  const preAuthAllowed = await takeExomemRateLimit(
    operation === "read"
      ? EXOMEM_RATE_LIMITS.adminPreAuthReadIp
      : EXOMEM_RATE_LIMITS.adminPreAuthMutationIp,
    clientAddressKey(request) ?? "unknown"
  );
  if (!preAuthAllowed) throw exomemErrors.rateLimited();
  const operator = requireExomemOperator(request);
  const allowed = await takeExomemRateLimit(
    operation === "read"
      ? EXOMEM_RATE_LIMITS.adminAuthenticatedRead
      : EXOMEM_RATE_LIMITS.adminAuthenticatedMutation,
    operator.principalDigest.toString("hex")
  );
  if (!allowed) throw exomemErrors.rateLimited();
  return operator;
}

export async function readOperatorJsonRecord(request: Request): Promise<Record<string, unknown>> {
  const body = await readBoundedJsonRequest(request, OPERATOR_BODY_MAX_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw exomemErrors.invalidRequest();
  return body as Record<string, unknown>;
}

export function operatorSuccessEvent(requestId: string): void {
  emitOperatorControlSuccess(requestId);
}

export function operatorErrorResponse(error: unknown, requestId: string) {
  return operatorControlErrorResponse(error, requestId);
}

export { newRequestId };
