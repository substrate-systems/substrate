/**
 * The closed vocabulary of `exomem_oauth_token_families.revoked_reason`: every
 * value the codebase writes, and whether that ending emails the owner. The set
 * is closed because the column is written only by this codebase, and every
 * writer names its reason through `OAUTH_FAMILY_END_REASON` — a literal
 * anywhere else is a bug. Adding a reason fails to compile until
 * `OAUTH_FAMILY_END_NOTIFIES` classifies it, and an end-of-life the map does
 * not know can only arrive as NULL (a plain expiry), which notifies.
 */
export const OAUTH_FAMILY_END_REASON = {
  /** The owner disconnected the app themselves. */
  ownerDisconnected: "owner_disconnected",
  /** The client asked for its own credential to be revoked (RFC 7009). */
  clientRevoked: "client_revoked",
  /** The account's lifecycle removed the grant (deletion, offboarding). */
  lifecycleDeleted: "lifecycle_deleted",
  /** The Cloud cell the grant pointed at was deleted. */
  cloudCellDeleted: "cloud_cell_deleted",
  /** The reviewer credential the grant depended on was revoked. */
  reviewerCredentialRevoked: "reviewer_credential_revoked",
  /** An operator revoked the family or the whole account. */
  operatorRevoked: "operator_revoked",
  /** A spent refresh token was presented after its reuse window. */
  refreshReplayed: "refresh_replayed",
} as const;

export type OAuthFamilyEndReason =
  (typeof OAUTH_FAMILY_END_REASON)[keyof typeof OAUTH_FAMILY_END_REASON];

/**
 * Whether an ending emails the owner. Owner- and client-initiated endings and
 * the lifecycle paths that remove the grant stay silent — the actor already
 * knows. System endings (replay protection, operator revocation) and a plain
 * expiry (NULL reason) notify: nobody else will say the app went quiet.
 */
const OAUTH_FAMILY_END_NOTIFIES: Record<OAuthFamilyEndReason, boolean> = {
  owner_disconnected: false,
  client_revoked: false,
  lifecycle_deleted: false,
  cloud_cell_deleted: false,
  reviewer_credential_revoked: false,
  operator_revoked: true,
  refresh_replayed: true,
};

/** The reasons that never email, for SQL's `<> ALL` — derived, so it cannot drift from the map. */
export const OAUTH_FAMILY_END_SILENT_REASONS = Object.entries(OAUTH_FAMILY_END_NOTIFIES)
  .filter(([, notifies]) => !notifies)
  .map(([reason]) => reason);
