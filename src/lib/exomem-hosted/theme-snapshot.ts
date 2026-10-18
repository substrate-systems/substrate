import type { NextResponse } from "next/server";
import { sqlWithin } from "@/lib/db/pg-sql";
import { readExomemThemeSnapshot, type ExomemThemeSnapshot } from "@/lib/exomem/theme";
import {
  EXOMEM_THEME_COOKIE_PREFIX,
  exomemThemeCookieName,
  themeBindingFromCsrfDigest,
  themeBindingFromCsrfToken,
} from "@/lib/exomem/theme-binding";
import { findExomemSessionByDigest, type ExomemSessionRow } from "./db";
import { digestSecret, tokenDigest } from "./security";

export function accountThemeSnapshot(session: ExomemSessionRow): ExomemThemeSnapshot {
  return {
    scope: digestSecret(`exomem-theme-account:${session.tenantId}`).toString("base64url"),
    binding: themeBindingFromCsrfDigest(session.csrfDigest),
    choice: session.themeChoice ?? null,
    effective: session.emailScheme ?? null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/** Only auth responses prune names: late HTML responses must never delete a newer session's snapshot. */
export function pruneExomemThemeSnapshots(
  response: NextResponse,
  request?: Request,
  keepBinding?: string
): void {
  const names = new Set(["exomem_theme", "exomem_theme_scope"]);
  for (const part of (request?.headers.get("cookie") ?? "").split(";")) {
    const name = part.slice(0, part.indexOf("=")).trim();
    if (
      name.startsWith(EXOMEM_THEME_COOKIE_PREFIX) &&
      name !== exomemThemeCookieName(keepBinding ?? "")
    )
      names.add(name);
  }
  for (const name of names) {
    response.cookies.set(name, "", {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
      maxAge: 0,
    });
  }
}

/** This read is presentation-only; callers still perform their normal authentication. */
export async function refreshExomemThemeSnapshot(
  response: NextResponse,
  sessionToken: string | null,
  csrfToken: string | null,
  cachedValue?: string | null
): Promise<void> {
  if (!sessionToken || !csrfToken) return;
  const binding = themeBindingFromCsrfToken(csrfToken);
  let snapshot: ExomemThemeSnapshot | null = null;
  let failed = false;
  try {
    const digest = tokenDigest(sessionToken);
    if (digest) {
      const session = await findExomemSessionByDigest(digest, sqlWithin(250));
      if (session) {
        const current = accountThemeSnapshot(session);
        if (current.binding === binding) snapshot = current;
      }
    }
  } catch {
    failed = true;
  }
  if (failed) {
    const cached = readExomemThemeSnapshot(cachedValue);
    if (cached?.binding === binding) snapshot = cached;
  }
  response.cookies.set(
    exomemThemeCookieName(binding),
    JSON.stringify(
      snapshot ?? { scope: "", binding, choice: "auto", effective: null, expiresAt: null }
    ),
    {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
      ...(snapshot?.expiresAt ? { expires: new Date(snapshot.expiresAt) } : {}),
    }
  );
}
