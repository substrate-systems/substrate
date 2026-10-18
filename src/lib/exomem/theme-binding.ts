import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const EXOMEM_THEME_COOKIE_PREFIX = "exomem_theme_v2_";

/** A cosmetic binding; neither the CSRF token nor its authentication digest is persisted here. */
export function themeBindingFromCsrfDigest(csrfDigest: Uint8Array): string {
  return bytesToHex(sha256(utf8ToBytes(`exomem-theme-v2:${bytesToHex(csrfDigest)}`)));
}

export function themeBindingFromCsrfToken(csrfToken: string): string {
  return csrfToken ? themeBindingFromCsrfDigest(sha256(utf8ToBytes(csrfToken))) : "";
}

export function exomemThemeCookieName(binding: string): string {
  return `${EXOMEM_THEME_COOKIE_PREFIX}${binding}`;
}
