import { themeBindingFromCsrfToken } from "@/lib/exomem/theme-binding";
import { pruneExomemThemeSnapshots, refreshExomemThemeSnapshot } from "./theme-snapshot";
import { NextResponse } from "next/server";
import { OWNER_SIGN_IN_TTL_MS } from "@/lib/exomem/access-limits";
import {
  findExomemSessionByDigest,
  revokeExomemSession,
  rotateExomemSessionAtomic,
  type ExomemSessionRow,
} from "./db";
import { exomemErrors } from "./errors";
import {
  constantTimeSecretEqual,
  digestSecret,
  generateExternalToken,
  tokenDigest,
  type RandomBytesSource,
} from "./security";

export const EXOMEM_SESSION_COOKIE = "exomem_session";
export const EXOMEM_CSRF_COOKIE = "exomem_csrf";
export const EXOMEM_CSRF_HEADER = "x-exomem-csrf";
export const EXOMEM_MAGIC_CHALLENGE_COOKIE = "exomem_magic_challenge";
export const EXOMEM_ACCESS_RECOVERY_COOKIE = "exomem_access_recovery";
export const EXOMEM_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionMaterial = {
  sessionToken: string;
  sessionDigest: Buffer;
  csrfToken: string;
  csrfDigest: Buffer;
  expiresAt: Date;
};

export type MagicLinkChallengeMaterial = {
  challengeToken: string;
  challengeDigest: Buffer;
  expiresAt: Date;
};

export function mintMagicLinkChallenge(
  input: { now?: Date; randomBytes?: RandomBytesSource } = {}
): MagicLinkChallengeMaterial {
  const now = input.now ?? new Date();
  const challengeToken = generateExternalToken(input.randomBytes);
  return {
    challengeToken,
    challengeDigest: digestSecret(challengeToken),
    expiresAt: new Date(now.getTime() + OWNER_SIGN_IN_TTL_MS),
  };
}

export function mintSessionMaterial(
  input: {
    now?: Date;
    randomBytes?: RandomBytesSource;
  } = {}
): SessionMaterial {
  const now = input.now ?? new Date();
  const sessionToken = generateExternalToken(input.randomBytes);
  const csrfToken = generateExternalToken(input.randomBytes);
  return {
    sessionToken,
    sessionDigest: digestSecret(sessionToken),
    csrfToken,
    csrfDigest: digestSecret(csrfToken),
    expiresAt: new Date(now.getTime() + EXOMEM_SESSION_TTL_MS),
  };
}

export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

export function magicLinkChallengeFromRequest(request: Request): string | null {
  return cookieValue(request, EXOMEM_MAGIC_CHALLENGE_COOKIE);
}

export function applyMagicLinkChallengeCookie(
  response: NextResponse,
  material: MagicLinkChallengeMaterial
): void {
  response.cookies.set(EXOMEM_MAGIC_CHALLENGE_COOKIE, material.challengeToken, {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/exomem/access/magic-link",
    expires: material.expiresAt,
    maxAge: Math.floor(OWNER_SIGN_IN_TTL_MS / 1000),
    httpOnly: true,
  });
}

export function clearMagicLinkChallengeCookie(response: NextResponse): void {
  response.cookies.set(EXOMEM_MAGIC_CHALLENGE_COOKIE, "", {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/exomem/access/magic-link",
    maxAge: 0,
    httpOnly: true,
  });
}

export type ExomemSessionContext = ExomemSessionRow;

/**
 * Login/token redemption sets authentication cookies, so it needs an origin
 * check even though there is no pre-existing CSRF cookie to validate. Requiring
 * JSON also prevents a cross-site HTML form from smuggling a token as
 * `text/plain` and swapping the victim browser into the attacker's tenant.
 */
export function validatePublicAccessRequest(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (contentType !== "application/json" || !origin || !host) {
    throw exomemErrors.csrfRejected();
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw exomemErrors.csrfRejected();
  }
  if (
    !["http:", "https:"].includes(originUrl.protocol) ||
    originUrl.host.toLowerCase() !== host.toLowerCase()
  ) {
    throw exomemErrors.csrfRejected();
  }
}

export async function resolveExomemSession(
  request: Request,
  dependencies: {
    findSession?: typeof findExomemSessionByDigest;
  } = {}
): Promise<ExomemSessionContext> {
  const sessionToken = cookieValue(request, EXOMEM_SESSION_COOKIE);
  if (!sessionToken) throw exomemErrors.sessionInvalid();
  const digest = tokenDigest(sessionToken);
  if (!digest) throw exomemErrors.sessionInvalid();
  const session = await (dependencies.findSession ?? findExomemSessionByDigest)(digest);
  if (!session) throw exomemErrors.sessionInvalid();
  return session;
}

export function validateMutationRequest(
  request: Request,
  session: Pick<ExomemSessionRow, "csrfDigest">
): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) throw exomemErrors.csrfRejected();
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw exomemErrors.csrfRejected();
  }
  if (
    !["http:", "https:"].includes(originUrl.protocol) ||
    originUrl.host.toLowerCase() !== host.toLowerCase()
  ) {
    throw exomemErrors.csrfRejected();
  }
  const csrfCookie = cookieValue(request, EXOMEM_CSRF_COOKIE);
  const csrfHeader = request.headers.get(EXOMEM_CSRF_HEADER);
  if (
    !csrfCookie ||
    !csrfHeader ||
    !constantTimeSecretEqual(csrfCookie, csrfHeader) ||
    !constantTimeSecretEqual(
      digestSecret(csrfCookie).toString("base64url"),
      Buffer.from(session.csrfDigest).toString("base64url")
    )
  ) {
    throw exomemErrors.csrfRejected();
  }
}

export async function applySessionCookies(
  response: NextResponse,
  material: Pick<SessionMaterial, "sessionToken" | "csrfToken" | "expiresAt">,
  request?: Request,
  now: Date = new Date()
): Promise<void> {
  const common = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: material.expiresAt,
    // Browsers prefer Max-Age to Expires, so it must end with the session row,
    // including a session capped earlier than the usual seven days.
    maxAge: Math.max(0, Math.floor((material.expiresAt.getTime() - now.getTime()) / 1000)),
  };
  response.cookies.set(EXOMEM_SESSION_COOKIE, material.sessionToken, {
    ...common,
    httpOnly: true,
  });
  response.cookies.set(EXOMEM_CSRF_COOKIE, material.csrfToken, {
    ...common,
    httpOnly: false,
  });
  pruneExomemThemeSnapshots(response, request, themeBindingFromCsrfToken(material.csrfToken));
  await refreshExomemThemeSnapshot(response, material.sessionToken, material.csrfToken);
}

export function clearSessionCookies(response: NextResponse, request?: Request): void {
  const common = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
  response.cookies.set(EXOMEM_SESSION_COOKIE, "", {
    ...common,
    httpOnly: true,
  });
  response.cookies.set(EXOMEM_CSRF_COOKIE, "", {
    ...common,
    httpOnly: false,
  });
  pruneExomemThemeSnapshots(response, request);
}

export async function revokeResolvedSession(
  session: Pick<ExomemSessionContext, "id">,
  revoke: typeof revokeExomemSession = revokeExomemSession
): Promise<void> {
  await revoke(session.id);
}

export async function rotateResolvedSession(
  session: ExomemSessionContext,
  options: {
    now?: Date;
    randomBytes?: RandomBytesSource;
    rotate?: typeof rotateExomemSessionAtomic;
  } = {}
): Promise<SessionMaterial> {
  const material = mintSessionMaterial(options);
  if (session.reviewerCredentialId) {
    material.expiresAt = new Date(
      Math.min(material.expiresAt.getTime(), new Date(session.expiresAt).getTime())
    );
  }
  const row = await (options.rotate ?? rotateExomemSessionAtomic)({
    sessionId: session.id,
    sessionDigest: material.sessionDigest,
    csrfDigest: material.csrfDigest,
    expiresAt: material.expiresAt,
  });
  if (!row) throw exomemErrors.sessionInvalid();
  return material;
}
