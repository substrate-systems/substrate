import { exomemErrors } from "./errors";
import { constantTimeSecretEqual, digestSecret, tokenDigest } from "./security";

export type ExomemOperatorContext = {
  principalDigest: Buffer;
  /** The admin token, or the release automation's deploy token. */
  principal: "admin" | "deploy";
};

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

export function requireExomemOperator(request: Request): ExomemOperatorContext {
  const configured = process.env.EXOMEM_ADMIN_TOKEN;
  if (!configured || !tokenDigest(configured)) {
    throw exomemErrors.adminDisabled();
  }
  const presented = bearerToken(request);
  if (!presented || !constantTimeSecretEqual(configured, presented)) {
    throw exomemErrors.adminUnauthorized();
  }
  return {
    principalDigest: digestSecret(`exomem-admin\0${configured}`),
    principal: "admin",
  };
}

/**
 * The release routes alone accept this principal. It reads the bounded
 * rollout view and sets the release image; the route refuses it everything
 * else (automate-cloud-releases D1).
 */
export function requireExomemDeployer(request: Request): ExomemOperatorContext {
  const configured = process.env.EXOMEM_DEPLOY_TOKEN;
  const presented = bearerToken(request);
  if (
    configured &&
    tokenDigest(configured) &&
    presented &&
    constantTimeSecretEqual(configured, presented)
  ) {
    return { principalDigest: digestSecret(`exomem-deploy\0${configured}`), principal: "deploy" };
  }
  return requireExomemOperator(request);
}
