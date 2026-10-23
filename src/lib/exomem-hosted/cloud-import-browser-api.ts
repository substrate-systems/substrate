import { cloudImportReply, type CloudImport } from "../exomem/cloud-import-contract";
import { csrfCookie, getPrivateJson, HostedBrowserError, postPrivateJson } from "./hosted-browser";

const path = "/api/exomem/cloud/imports";

/** A stale page must not send its selected files under another tab's new account. */
export function assertImportAccount(csrfToken: string) {
  if (!csrfToken || csrfToken !== csrfCookie()) {
    throw new HostedBrowserError(
      {
        code: "IMPORT_ACCOUNT_CHANGED",
        message: "The signed-in account changed. Reload Home before continuing the import.",
      },
      403
    );
  }
}

/** Status is an observation; a successful mutation does not establish completed import. */
export async function readBrowserImport(
  csrfToken: string,
  importId?: string,
  signal?: AbortSignal
): Promise<CloudImport | null> {
  assertImportAccount(csrfToken);
  const result = cloudImportReply.parse(
    await getPrivateJson(importId ? `${path}/${encodeURIComponent(importId)}` : path, signal)
  ).import;
  assertImportAccount(csrfToken);
  return result;
}

export async function requestBrowserImport(
  csrfToken: string,
  importId: string,
  action: "create" | "prepare-upload" | "complete" | "cancel" | "discard",
  body: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<CloudImport> {
  assertImportAccount(csrfToken);
  const response = await postPrivateJson(
    action === "create" ? path : `${path}/${encodeURIComponent(importId)}/${action}`,
    action === "create" ? { ...body, import_id: importId } : body,
    "POST",
    { csrfToken, signal }
  );
  assertImportAccount(csrfToken);
  const result = cloudImportReply.parse(response).import;
  if (!result || result.import_id !== importId) {
    throw new Error(
      "The import response did not match this upload. Check its status before retrying."
    );
  }
  return result;
}
