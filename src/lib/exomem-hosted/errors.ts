export type ExomemHostedErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable: boolean;
    retryAfterMs?: number;
    remediation?: string;
  };
};

export class ExomemHostedError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly remediation?: string;

  constructor(params: {
    code: string;
    status: number;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    remediation?: string;
  }) {
    super(params.message);
    this.name = "ExomemHostedError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable ?? false;
    this.retryAfterMs = params.retryAfterMs;
    this.remediation = params.remediation;
  }

  toJSON(): ExomemHostedErrorEnvelope["error"] {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.remediation ? { remediation: this.remediation } : {}),
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
  emailConfirmationRequired: () =>
    new ExomemHostedError({
      code: "EMAIL_CONFIRMATION_REQUIRED",
      status: 401,
      message: "confirm your email to continue sign-in",
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
  capacityUnavailable: () =>
    new ExomemHostedError({
      code: "CAPACITY_UNAVAILABLE",
      status: 503,
      message: "hosted capacity is temporarily unavailable",
      retryable: true,
      retryAfterMs: 1000,
      remediation: "retry_later",
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
  cellMappingAmbiguous: () =>
    new ExomemHostedError({
      code: "CELL_MAPPING_AMBIGUOUS",
      status: 503,
      message: "the Exomem service mapping is unavailable",
    }),
  entitlementDenied: () =>
    new ExomemHostedError({
      code: "EXOMEM_ENTITLEMENT_DENIED",
      status: 403,
      message: "your current Exomem access does not include this action",
    }),
  requestTooLarge: () =>
    new ExomemHostedError({
      code: "TOO_LARGE",
      status: 413,
      message: "the request is too large",
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
      ...(safe.retryAfterMs ? { retryAfterMs: safe.retryAfterMs } : {}),
      ...(safe.remediation ? { remediation: safe.remediation } : {}),
    },
  };
}

export function safeErrorResponse(error: unknown, requestId?: string): Response {
  const status = error instanceof ExomemHostedError ? error.status : 500;
  return Response.json(safeErrorEnvelope(error, requestId), { status });
}
