/**
 * The one EdDSA JWT signer for the signed objects that Cloud cells verify: the
 * gateway's request proofs (`src/exomem-gateway/cloud-origin.ts`) and the
 * control plane's operation grants (`cloud-operation-grants.ts`). The cell
 * checks all of them with one function, so they share one header, one `iat`,
 * `exp` and `jti` rule, and differ only in key, audience, lifetime and claims.
 */

import { randomUUID, type KeyObject } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";

export type CloudJwtOptions = {
  key: KeyObject;
  audience: string;
  /** Seconds from `now` to `exp`. */
  lifetimeSeconds: number;
  /** Seconds since the epoch; becomes `iat`. */
  now: number;
  /** Omitted unless the object's verifier requires an `iss` claim. */
  issuer?: string;
};

export function signCloudJwt(claims: JWTPayload, options: CloudJwtOptions): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setAudience(options.audience)
    .setIssuedAt(options.now)
    .setExpirationTime(options.now + options.lifetimeSeconds)
    .setJti(randomUUID());
  if (options.issuer !== undefined) jwt.setIssuer(options.issuer);
  return jwt.sign(options.key);
}
