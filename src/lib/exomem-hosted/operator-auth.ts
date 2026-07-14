import { exomemErrors } from "./errors";
import { constantTimeSecretEqual, digestSecret, tokenDigest } from "./security";

export type ExomemOperatorContext = {
  principalDigest: Buffer;
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
  };
}
