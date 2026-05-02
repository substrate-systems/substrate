/**
 * Shared types for the Hosted Backup module.
 * Shapes locked in `hosted-backup-contract.md` (repo root).
 */

export const SchemaVersion = '1.0' as const;
export type SchemaVersion = typeof SchemaVersion;

export type SubscriptionStatus = 'none' | 'active' | 'grace' | 'cancelled';

export type KdfParams = {
  algorithm: 'argon2id';
  memory: number;
  iterations: number;
  parallelism: number;
};

export const KDF_FLOOR: Readonly<KdfParams> = Object.freeze({
  algorithm: 'argon2id',
  memory: 65536,
  iterations: 3,
  parallelism: 4,
});

export type JwtClaims = {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nbf: number;
  jti: string;
  subscription_status: SubscriptionStatus;
};

// --- Auth request/response shapes ---

export type SignupRequest = {
  email: string;
  serverPassword: string; // base64
  salt: string; // base64
  kdfParams: KdfParams;
  wrappedDEK: string; // base64
  recoveryKeyVerifier: string; // base64 (the proof bytes; server hashes them)
  recoveryKeyWrappedDEK: string; // base64
};

export type SignupResponse = {
  userId: string;
  accessToken: string;
  refreshToken: string;
};

export type LoginStep1Request = { email: string };
export type LoginStep1Response = { salt: string; kdfParams: KdfParams };

export type LoginStep2Request = { email: string; serverPassword: string };
export type LoginStep2Response = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  wrappedDEK: string;
};

export type RefreshRequest = { refreshToken: string };
export type RefreshResponse = { accessToken: string; refreshToken: string };

export type LogoutRequest = { refreshToken: string };
export type LogoutResponse = { ok: true };

export type RecoverRequest = { email: string; recoveryKeyProof: string };
export type RecoverResponse = {
  recoveryToken: string;
  recoveryKeyWrappedDEK: string;
};

export type RecoverFinalizeRequest = {
  recoveryToken: string;
  newServerPassword: string;
  newSalt: string;
  newKdfParams: KdfParams;
  newWrappedDEK: string;
};
export type RecoverFinalizeResponse = {
  accessToken: string;
  refreshToken: string;
};

// --- Account ---

export type AccountMeResponse = {
  userId: string;
  email: string;
  subscriptionStatus: SubscriptionStatus;
  createdAt: string;
};

export type AccountDeleteResponse = { ok: true };

// --- Backups (storage) ---

export type BackupSummary = {
  id: string;
  name: string;
  latestVersionId: string | null;
  versionCount: number;
  totalSize: number;
  updatedAt: string;
};

export type ListBackupsResponse = { backups: BackupSummary[] };

export type CreateBackupRequest = { name: string };
export type CreateBackupResponse = { backupId: string };

export type VersionSummary = {
  versionId: string;
  createdAt: string;
  size: number;
  manifestSha256: string; // hex
};
export type ListVersionsResponse = { versions: VersionSummary[] };

export type ChunkMetadata = {
  index: number;
  encryptedSize: number;
  sha256: string; // hex
};

export type CreateVersionRequest = {
  encryptedManifest: string; // base64
  chunkMetadata: ChunkMetadata[];
};

export type UploadUrl = {
  chunkIndex: number;
  presignedUrl: string;
  expiresAt: string; // ISO-8601
};

export type CreateVersionResponse = {
  versionId: string;
  uploadUrls: UploadUrl[];
};

export type DownloadUrlsRequest = { chunkIndices: number[] };
export type DownloadUrlsResponse = { urls: UploadUrl[] };

// --- Storage constants ---

export const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB, contract §8
export const VERSION_RETENTION = 5; // contract §8
export const PRESIGNED_URL_TTL_S = 300; // contract §8

// --- OIDC discovery (contract §9) ---

export type EndstateExtensions = {
  auth_signup_endpoint: string;
  auth_login_endpoint: string;
  auth_refresh_endpoint: string;
  auth_logout_endpoint: string;
  auth_recover_endpoint: string;
  backup_api_base: string;
  supported_kdf_algorithms: ['argon2id'];
  supported_envelope_versions: number[];
  min_kdf_params: { memory: number; iterations: number; parallelism: number };
};

export type OidcDiscoveryDocument = {
  issuer: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: ['EdDSA'];
  endstate_extensions: EndstateExtensions;
};

export type Jwk = {
  kty: 'OKP';
  crv: 'Ed25519';
  alg: 'EdDSA';
  use: 'sig';
  kid: string;
  x: string; // base64url
};
export type Jwks = { keys: Jwk[] };

// --- Error envelope (contract §7) ---

export type ErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
    remediation?: string;
    docsKey?: string;
  };
};
