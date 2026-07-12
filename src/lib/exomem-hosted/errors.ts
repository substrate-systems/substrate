import { NextResponse } from "next/server";

export type ExomemHostedErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable: boolean;
  };
};

export class ExomemHostedError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(params: { code: string; status: number; message: string; retryable?: boolean }) {
    super(params.message);
    this.name = "ExomemHostedError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable ?? false;
  }

  toJSON(): ExomemHostedErrorEnvelope["error"] {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const exomemErrors = {
  invalidRequest: () =>
    new ExomemHostedError({
      code: "INVALID_REQUEST",
      status: 400,
      message: "the request could not be accepted",
    }),
  invalidEmail: () =>
    new ExomemHostedError({
      code: "INVALID_EMAIL",
      status: 400,
      message: "a valid email address is required",
    }),
  invalidExpiry: () =>
    new ExomemHostedError({
      code: "INVALID_EXPIRY",
      status: 400,
      message: "the requested expiry is outside the allowed window",
    }),
  invalidEntitlementSource: () =>
    new ExomemHostedError({
      code: "INVALID_ENTITLEMENT_SOURCE",
      status: 400,
      message: "the requested access source is not supported",
    }),
  adminUnauthorized: () =>
    new ExomemHostedError({
      code: "ADMIN_UNAUTHORIZED",
      status: 401,
      message: "operator authentication failed",
    }),
  adminDisabled: () =>
    new ExomemHostedError({
      code: "ADMIN_DISABLED",
      status: 503,
      message: "operator invite access is unavailable",
      retryable: true,
    }),
  accessTokenInvalid: () =>
    new ExomemHostedError({
      code: "ACCESS_TOKEN_INVALID",
      status: 401,
      message: "the access link is invalid or unavailable",
    }),
  sessionInvalid: () =>
    new ExomemHostedError({
      code: "EXOMEM_SESSION_INVALID",
      status: 401,
      message: "an Exomem session is required",
    }),
  csrfRejected: () =>
    new ExomemHostedError({
      code: "CSRF_REJECTED",
      status: 403,
      message: "the browser request could not be verified",
    }),
  rateLimited: () =>
    new ExomemHostedError({
      code: "RATE_LIMITED",
      status: 429,
      message: "too many requests",
      retryable: true,
    }),
  emailDeliveryUnavailable: () =>
    new ExomemHostedError({
      code: "EMAIL_DELIVERY_UNAVAILABLE",
      status: 503,
      message: "access email delivery is temporarily unavailable",
      retryable: true,
    }),
  controlPlaneKeyInvalid: () =>
    new ExomemHostedError({
      code: "CONTROL_PLANE_KEY_INVALID",
      status: 500,
      message: "control-plane secret configuration is invalid",
    }),
  encryptedSecretInvalid: () =>
    new ExomemHostedError({
      code: "ENCRYPTED_SECRET_INVALID",
      status: 500,
      message: "protected secret material is invalid",
    }),
  cellMappingMissing: () =>
    new ExomemHostedError({
      code: "CELL_MAPPING_MISSING",
      status: 503,
      message: "the Exomem service is not ready",
      retryable: true,
    }),
  cellMappingAmbiguous: () =>
    new ExomemHostedError({
      code: "CELL_MAPPING_AMBIGUOUS",
      status: 503,
      message: "the Exomem service mapping is unavailable",
    }),
  cellUnavailable: () =>
    new ExomemHostedError({
      code: "CELL_UNAVAILABLE",
      status: 503,
      message: "your Exomem is temporarily unavailable",
      retryable: true,
    }),
  protocolMismatch: () =>
    new ExomemHostedError({
      code: "CELL_PROTOCOL_MISMATCH",
      status: 503,
      message: "the Exomem service is being updated",
      retryable: true,
    }),
  selectorRejected: () =>
    new ExomemHostedError({
      code: "HOSTED_SELECTOR_REJECTED",
      status: 400,
      message: "the request contains unsupported routing fields",
    }),
  commandNotFound: () =>
    new ExomemHostedError({
      code: "COMMAND_NOT_FOUND",
      status: 404,
      message: "that Exomem action is not available",
    }),
  commandInterceptRequired: () =>
    new ExomemHostedError({
      code: "HOSTED_INTERCEPT_REQUIRED",
      status: 409,
      message: "use the dedicated Exomem import or transfer flow",
    }),
  entitlementDenied: () =>
    new ExomemHostedError({
      code: "EXOMEM_ENTITLEMENT_DENIED",
      status: 403,
      message: "your current Exomem access does not include this action",
    }),
  suspensionActive: () =>
    new ExomemHostedError({
      code: "EXOMEM_SUSPENDED",
      status: 403,
      message: "your Exomem is currently suspended",
    }),
  idempotencyRequired: () =>
    new ExomemHostedError({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      status: 400,
      message: "a retry key is required for this change",
    }),
  idempotencyConflict: () =>
    new ExomemHostedError({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
      message: "that retry key is already bound to a different request",
    }),
  cellResponseInvalid: () =>
    new ExomemHostedError({
      code: "CELL_RESPONSE_INVALID",
      status: 502,
      message: "the Exomem cell returned an invalid response",
      retryable: true,
    }),
  requestTooLarge: () =>
    new ExomemHostedError({
      code: "TOO_LARGE",
      status: 413,
      message: "the request is too large",
    }),
  exportNotFound: () =>
    new ExomemHostedError({
      code: "EXOMEM_EXPORT_NOT_FOUND",
      status: 404,
      message: "that verified export is not available",
    }),
  exportExpired: () =>
    new ExomemHostedError({
      code: "EXOMEM_EXPORT_EXPIRED",
      status: 410,
      message: "that export has expired",
    }),
  exportUnavailable: () =>
    new ExomemHostedError({
      code: "EXOMEM_EXPORT_UNAVAILABLE",
      status: 503,
      message: "verified export is temporarily unavailable",
      retryable: true,
    }),
} as const;

export function safeErrorEnvelope(error: unknown, requestId?: string): ExomemHostedErrorEnvelope {
  const safe =
    error instanceof ExomemHostedError
      ? error
      : new ExomemHostedError({
          code: "INTERNAL_ERROR",
          status: 500,
          message: "unexpected server error",
        });
  return {
    success: false,
    error: {
      code: safe.code,
      message: safe.message,
      ...(requestId ? { requestId } : {}),
      retryable: safe.retryable,
    },
  };
}

export function safeErrorResponse(
  error: unknown,
  requestId?: string
): NextResponse<ExomemHostedErrorEnvelope> {
  const status = error instanceof ExomemHostedError ? error.status : 500;
  return NextResponse.json(safeErrorEnvelope(error, requestId), { status });
}
