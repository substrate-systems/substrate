import { NextResponse } from "next/server";
import { SchemaVersion } from "./types";

/**
 * Tags a NextResponse with the contract §11 API version header. Wrap every
 * response from `/api/auth/`, `/api/account/`, `/api/.well-known/`,
 * `/api/backups/` (PR2), and `/api/webhooks/paddle` (PR3) with this.
 */
export function withApiVersion(response: NextResponse, apiVersion = SchemaVersion): NextResponse {
  response.headers.set("X-Endstate-API-Version", apiVersion);
  return response;
}

/**
 * Lowest client schema that participates in the two-phase version commit
 * (contract §7, §8). Clients advertise their schema on the REQUEST side with
 * the same `X-Endstate-API-Version` header the server sets on responses.
 */
/**
 * Whether the caller understands `POST /api/backups/:id/versions/:vid/commit`.
 *
 * Every new version is pending. Modern clients finish the protocol through
 * the explicit commit endpoint; older and malformed clients are reconciled by
 * the server after it has proved every R2 object exists at the expected size.
 * Returning true here keeps a version from becoming visible merely because a
 * caller omitted a negotiation header.
 */
export function clientRequiresVersionCommit(headerValue: string | null | undefined): boolean {
  void headerValue;
  return true;
}

/** Whether this caller knows the explicit commit endpoint. */
export function clientSupportsExplicitVersionCommit(
  headerValue: string | null | undefined
): boolean {
  if (!headerValue) return false;
  const match = /^\s*(\d+)\.(\d+)\s*$/.exec(headerValue);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isFinite(major) && Number.isFinite(minor) && major === 2 && minor >= 1;
}

/** Reject a syntactically valid but unsupported major before any write. */
export function hasUnsupportedClientMajor(headerValue: string | null | undefined): boolean {
  if (!headerValue) return false;
  const match = /^\s*(\d+)\.(\d+)\s*$/.exec(headerValue);
  return Boolean(match && Number(match[1]) !== 2);
}

/**
 * Compatibility release: always emit 2.0 while still accepting a 2.1 request
 * header to select explicit commit. Released 2.0 engines reject a 2.1 response
 * after mutation, so the response bump must wait for their retirement.
 */
export function responseApiVersionForRequest(
  headerValue: string | null | undefined
): typeof SchemaVersion {
  void headerValue;
  return SchemaVersion;
}

export function jsonWithApiVersion<T>(
  body: T,
  init?: number | ResponseInit,
  apiVersion?: typeof SchemaVersion
): NextResponse {
  const status = typeof init === "number" ? init : (init?.status ?? 200);
  const res = NextResponse.json(body, { ...(typeof init === "object" ? init : {}), status });
  return withApiVersion(res, apiVersion);
}
