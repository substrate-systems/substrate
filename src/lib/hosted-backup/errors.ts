import { jsonWithApiVersion } from './api-version';
import type { ErrorEnvelope } from './types';

/**
 * Domain error for Hosted Backup. Throw at any layer; route handlers catch
 * and convert via `errorResponse` to the contract §7 envelope shape.
 */
export class HostedBackupError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: Record<string, unknown>;
  readonly remediation?: string;
  readonly docsKey?: string;

  constructor(params: {
    code: string;
    status: number;
    message: string;
    detail?: Record<string, unknown>;
    remediation?: string;
    docsKey?: string;
  }) {
    super(params.message);
    this.name = 'HostedBackupError';
    this.code = params.code;
    this.status = params.status;
    this.detail = params.detail;
    this.remediation = params.remediation;
    this.docsKey = params.docsKey;
  }
}

export function errorResponse(err: unknown) {
  if (err instanceof HostedBackupError) {
    const envelope: ErrorEnvelope = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.remediation ? { remediation: err.remediation } : {}),
        ...(err.docsKey ? { docsKey: err.docsKey } : {}),
      },
    };
    return jsonWithApiVersion(envelope, err.status);
  }
  console.error('[hosted-backup error] unhandled:', err);
  const envelope: ErrorEnvelope = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'unexpected server error',
    },
  };
  return jsonWithApiVersion(envelope, 500);
}

// --- Common error constructors ---

export const errors = {
  badRequest: (message: string, detail?: Record<string, unknown>) =>
    new HostedBackupError({ code: 'BAD_REQUEST', status: 400, message, detail }),
  unauthenticated: (message = 'authentication required') =>
    new HostedBackupError({ code: 'UNAUTHENTICATED', status: 401, message }),
  invalidToken: (message = 'invalid token') =>
    new HostedBackupError({ code: 'INVALID_TOKEN', status: 401, message }),
  tokenExpired: (message = 'token expired') =>
    new HostedBackupError({ code: 'TOKEN_EXPIRED', status: 401, message }),
  invalidCredentials: () =>
    new HostedBackupError({
      code: 'INVALID_CREDENTIALS',
      status: 401,
      message: 'email or password is incorrect',
    }),
  invalidRecoveryKey: () =>
    new HostedBackupError({
      code: 'INVALID_RECOVERY_KEY',
      status: 401,
      message: 'recovery key proof did not verify',
    }),
  recoveryTokenExpired: () =>
    new HostedBackupError({
      code: 'RECOVERY_TOKEN_EXPIRED',
      status: 401,
      message: 'recovery token expired',
    }),
  refreshReuseDetected: () =>
    new HostedBackupError({
      code: 'REFRESH_REUSE_DETECTED',
      status: 401,
      message: 'refresh token already used; chain revoked',
    }),
  refreshExpired: () =>
    new HostedBackupError({
      code: 'REFRESH_EXPIRED',
      status: 401,
      message: 'refresh token expired',
    }),
  refreshInvalid: () =>
    new HostedBackupError({
      code: 'REFRESH_INVALID',
      status: 401,
      message: 'refresh token is invalid',
    }),
  emailTaken: () =>
    new HostedBackupError({
      code: 'EMAIL_TAKEN',
      status: 409,
      message: 'an account already exists for this email',
    }),
  emailNotFound: () =>
    new HostedBackupError({
      code: 'EMAIL_NOT_FOUND',
      status: 404,
      message: 'no account for this email',
    }),
  kdfTooWeak: (detail?: Record<string, unknown>) =>
    new HostedBackupError({
      code: 'KDF_TOO_WEAK',
      status: 400,
      message: 'kdf parameters are below the v1 floor',
      detail,
    }),
};
