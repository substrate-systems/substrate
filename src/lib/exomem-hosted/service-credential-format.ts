/**
 * The service-credential wire formats (change add-cloud-service-credentials).
 * A leaf module so the token mint can reserve the prefix without importing the
 * credential store, and so route tests import the production regex rather than
 * mirroring a copy that could drift.
 */

/**
 * Design D2: the secret's own prefix selects the lookup. `exs_` followed by 32
 * random bytes in base64url is a service credential; every other bearer is an
 * OAuth candidate. The two kinds can never be accepted as each other, which is
 * why no other opaque token may ever begin with this prefix — the mint in
 * security.ts redraws the rare collision.
 */
export const SERVICE_CREDENTIAL_PREFIX = "exs_";

/**
 * The principal format design D7 fixes: `service:<name>`. A format check on an
 * identifier, not a list of products — a new product needs no code change.
 */
export const SERVICE_CREDENTIAL_PRINCIPAL_FORMAT = /^service:[a-z][a-z0-9-]{0,39}$/;
