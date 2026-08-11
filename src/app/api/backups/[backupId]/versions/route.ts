import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { errors, errorResponse, HostedBackupError } from "@/lib/hosted-backup/errors";
import { requireReadAccess, requireWriteAccess } from "@/lib/hosted-backup/auth-middleware";
import { createVersionWithUploads, listVersionsOwned } from "@/lib/hosted-backup/storage";
import {
  clientRequiresVersionCommit,
  clientSupportsExplicitVersionCommit,
  hasUnsupportedClientMajor,
  jsonWithApiVersion,
  responseApiVersionForRequest,
} from "@/lib/hosted-backup/api-version";
import type {
  CreateVersionRequest,
  CreateVersionResponse,
  ListVersionsResponse,
} from "@/lib/hosted-backup/types";

export const runtime = "nodejs";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function resolveOperationId(headerValue: string | null, bodyValue: unknown): string | undefined {
  if (bodyValue !== undefined && typeof bodyValue !== "string") {
    throw errors.badRequest(
      "operationId must be a non-empty operation identifier up to 128 characters"
    );
  }
  const bodyOperationId = bodyValue as string | undefined;
  const headerOperationId = headerValue ?? undefined;
  if (
    headerOperationId !== undefined &&
    bodyOperationId !== undefined &&
    headerOperationId !== bodyOperationId
  ) {
    throw errors.badRequest(
      "X-Endstate-Operation-ID must match body operationId when both are supplied"
    );
  }
  const operationId = headerOperationId ?? bodyOperationId;
  if (operationId !== undefined && !OPERATION_ID.test(operationId)) {
    throw errors.badRequest("operationId must be 1-128 URL-safe identifier characters");
  }
  return operationId;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ backupId: string }> }) {
  try {
    const { userId } = await requireReadAccess(req);
    const { backupId } = await params;
    if (!backupId) throw errors.badRequest("backupId is required");
    const versions = await listVersionsOwned({ userId, backupId });
    const body: ListVersionsResponse = { versions };
    return jsonWithApiVersion(body, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error("[hosted-backup versions GET] unhandled:", err);
    }
    return errorResponse(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string }> }
) {
  try {
    const { userId } = await requireWriteAccess(req);
    const { backupId } = await params;
    if (!backupId) throw errors.badRequest("backupId is required");
    const clientVersion = req.headers.get("x-endstate-api-version");
    if (hasUnsupportedClientMajor(clientVersion)) {
      throw errors.badRequest("unsupported X-Endstate-API-Version major");
    }

    let body: CreateVersionRequest;
    try {
      body = (await req.json()) as CreateVersionRequest;
    } catch {
      throw errors.badRequest("invalid JSON body");
    }
    if (typeof body.encryptedManifest !== "string") {
      throw errors.badRequest("encryptedManifest is required");
    }
    // The engine sends the operation identity as a header so a retry can replay
    // the identical request body. The body field remains an additive legacy
    // compatibility path; conflicting carriers are rejected rather than
    // choosing one and accidentally minting another generation.
    const suppliedOperationId = resolveOperationId(
      req.headers.get("x-endstate-operation-id"),
      body.operationId
    );
    // The migration's insert guard blocks a pre-0040 application binary in
    // the Vercel build window. Generate an opaque identity for old engines,
    // which remain compatible without knowing or replaying it.
    const operationId = suppliedOperationId ?? randomUUID();
    const manifestBytes = new Uint8Array(Buffer.from(body.encryptedManifest, "base64"));
    if (manifestBytes.length === 0) {
      throw errors.badRequest("encryptedManifest must decode to non-empty bytes");
    }

    // Every generation begins pending. Schema-2.1+ clients close it with the
    // explicit commit endpoint; server reconciliation closes the compatibility
    // path for older clients only after R2 proves the complete generation.
    const requiresCommit = clientRequiresVersionCommit(clientVersion);
    const clientCommitRequired = clientSupportsExplicitVersionCommit(clientVersion);
    const responseApiVersion = responseApiVersionForRequest(clientVersion);

    const result = await createVersionWithUploads({
      userId,
      backupId,
      encryptedManifest: manifestBytes,
      chunkMetadata: body.chunkMetadata,
      requiresCommit,
      clientCommitRequired,
      operationId,
    });

    const respBody: CreateVersionResponse = {
      versionId: result.versionId,
      uploadUrls: result.uploadUrls,
      requiresCommit: result.requiresCommit,
      ...(result.alreadyCommitted ? { alreadyCommitted: true } : {}),
    };
    return jsonWithApiVersion(respBody, 200, responseApiVersion);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error("[hosted-backup versions POST] unhandled:", err);
    }
    return errorResponse(err);
  }
}
