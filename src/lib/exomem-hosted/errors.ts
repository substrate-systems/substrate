import { NextResponse } from "next/server";
import {
  HOSTED_COHORT_CLOSURE_REASONS,
  type HostedCohortClosureReason,
} from "./hosted-cohort-target";

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

/**
 * Diagnosis that stays inside the building.
 *
 * `remediation` is what the person who hit the error is told; this is what the
 * operator who has to clear it needs, and the two are not the same audience.
 * Neither `toJSON` nor `safeErrorEnvelope` reads it, so nothing here can reach
 * a public response. Values are fixed labels from this module, never derived
 * from a tenant, a request, or anything else a caller supplies.
 *
 * The key space is closed. This is spread into the denial log's input, so an
 * open key space would let a detail name a field the log builds itself —
 * `outcome`, `errorCode`, `requestId` — and either forge it or, by giving
 * `outcome` a value no event may carry, make `buildOperationalEvent` throw out
 * of the very refusal path this exists to keep clean. The spread is ordered so
 * the log's own fields win regardless; the closed key space is what stops such
 * a detail being written in the first place.
 */
export type OperatorErrorDetailKey =
  | "closureReason"
  | "closureSite"
  | "closureSummary"
  | "closureProcedure"
  | "closureRunbook";
export type OperatorErrorDetail = Readonly<Partial<Record<OperatorErrorDetailKey, string>>>;

export class ExomemHostedError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly remediation?: string;
  readonly operatorDetail?: OperatorErrorDetail;

  constructor(params: {
    code: string;
    status: number;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    remediation?: string;
    operatorDetail?: OperatorErrorDetail;
  }) {
    super(params.message);
    this.name = "ExomemHostedError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable ?? false;
    this.retryAfterMs = params.retryAfterMs;
    this.remediation = params.remediation;
    this.operatorDetail = params.operatorDetail;
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

/**
 * Reasons inferred from control flow rather than proved by the probe, and so
 * never eligible to carry a procedure.
 */
export const INFERRED_ADMISSION_CLOSURE_REASONS = ["live_cohort_lost"] as const;
export type InferredAdmissionClosureReason = (typeof INFERRED_ADMISSION_CLOSURE_REASONS)[number];

/**
 * Why hosted admission is shut.
 *
 * `HOSTED_ADMISSION_CLOSED` is raised from three places, over closures that mean
 * different things to whoever has to clear them, and the same thing to the
 * person refused: their invitation is intact and they should come back later. So
 * the reason is carried for the operator and the public code and copy stay as
 * they are — a distinct public code would change a contract every client would
 * have to learn for a distinction none of them can act on.
 *
 * Most of these come from `HOSTED_COHORT_CLOSURE_REASONS`, where the same query
 * that decided to refuse also established which closure it was. The rest are
 * inferred, and are held to a lower claim accordingly.
 */
export const ADMISSION_CLOSURE_REASONS = [
  ...HOSTED_COHORT_CLOSURE_REASONS,
  ...INFERRED_ADMISSION_CLOSURE_REASONS,
] as const;
export type AdmissionClosureReason = (typeof ADMISSION_CLOSURE_REASONS)[number];

/**
 * Which of the three refusal sites raised it.
 *
 * `oauth_first_owner_admission` is classified but, today, not logged. The OAuth
 * invite route (`src/app/api/exomem/oauth/authorize/invite/route.ts`) emits no
 * operational event and turns `HOSTED_ADMISSION_CLOSED` into a `403
 * access_denied` redirect, so a refusal raised there only reaches a denial log
 * when the same closure is met again through `/api/exomem/access/redeem`. That
 * hole predates this classification and is left alone; the note is here so the
 * site label does not read as a promise of observability it cannot keep.
 */
export const ADMISSION_CLOSURE_SITES = [
  "invite_redemption_precheck",
  "invite_redemption_settlement",
  "oauth_first_owner_admission",
] as const;
export type AdmissionClosureSite = (typeof ADMISSION_CLOSURE_SITES)[number];

type ClosureRemedy = { summary: string };
/**
 * A remedy that names a procedure. Only a reason the probe proves may be one:
 * an operator sent to a procedure for a state nobody established would be
 * acting on a guess, and the guess this taxonomy exists to remove is exactly
 * "admission is shut, so the fleet must be empty".
 */
type ProvenClosureRemedy = ClosureRemedy & { procedure: string; runbook: string };

const ADMISSION_CLOSURE_REMEDIES: Readonly<
  Record<HostedCohortClosureReason, ClosureRemedy | ProvenClosureRemedy> &
    Record<InferredAdmissionClosureReason, ClosureRemedy>
> = {
  no_live_candidate: {
    summary: "no hosted cohort candidate is live, so a v2 provision has no exact contract to name",
    procedure: "virgin-install-reviewer-oauth-bootstrap",
    runbook: "docs/runbooks/exomem-hosted-alpha.md#virgin-install-reviewer-oauth-bootstrap",
  },
  no_bound_cell_for_live_candidate: {
    summary:
      "a hosted cohort candidate is live, but no bound cell serves its release, protocol and fingerprints",
  },
  bound_cells_disagree_on_contract: {
    summary:
      "the bound cells serving the live hosted cohort candidate report more than one gateway contract digest",
  },
  live_cohort_lost: {
    // Reachable only if the target moved between the pre-check and the
    // settlement inside one transaction. `redeemInviteAtomic` takes the
    // `exomem-hosted-alpha-cohort` advisory lock before the pre-check, so the
    // candidate side cannot move under it; whether every `exomem_cells` writer
    // takes the matching lock has not been audited. So observing this at all is
    // a louder fact than the summary says: it may mean a rotation raced a
    // redemption, or it may mean that advisory-lock invariant is broken. Either
    // way there is no procedure to send anyone to, because nothing here
    // establishes which.
    summary:
      "a live hosted cohort target was present at the pre-check and gone before the redemption settled",
  },
};

/** The procedure labels that may appear in a denial log, for its allow-list. */
export const ADMISSION_CLOSURE_PROCEDURES = Object.values(ADMISSION_CLOSURE_REMEDIES)
  .map((remedy) => ("procedure" in remedy ? remedy.procedure : undefined))
  .filter((procedure): procedure is string => procedure !== undefined);

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
  capacityUnavailable: () =>
    new ExomemHostedError({
      code: "CAPACITY_UNAVAILABLE",
      status: 503,
      message: "hosted capacity is temporarily unavailable",
      retryable: true,
      retryAfterMs: 1000,
      remediation: "retry_later",
    }),
  admissionClosed: (closure: { reason: AdmissionClosureReason; site: AdmissionClosureSite }) => {
    const remedy = ADMISSION_CLOSURE_REMEDIES[closure.reason];
    return new ExomemHostedError({
      code: "HOSTED_ADMISSION_CLOSED",
      status: 503,
      message: "hosted admission is temporarily closed",
      retryable: true,
      remediation:
        "Your invitation is still valid and has not been used. Exomem Hosted is not admitting " +
        "new accounts until its service catalogue is updated. Open the link again later, or " +
        "tell whoever invited you.",
      operatorDetail: {
        closureReason: closure.reason,
        closureSite: closure.site,
        closureSummary: remedy.summary,
        ...("procedure" in remedy
          ? { closureProcedure: remedy.procedure, closureRunbook: remedy.runbook }
          : {}),
      },
    });
  },
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
      ...(safe.retryAfterMs ? { retryAfterMs: safe.retryAfterMs } : {}),
      ...(safe.remediation ? { remediation: safe.remediation } : {}),
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
