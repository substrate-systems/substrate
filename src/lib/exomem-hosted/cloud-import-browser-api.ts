import {
  cloudImportReply,
  type CloudImport,
  type CloudImportReply,
} from "../exomem/cloud-import-contract";
import { ImportStop } from "./cloud-import-stop";
import { csrfCookie, getPrivateJson, HostedBrowserError, postPrivateJson } from "./hosted-browser";

const path = "/api/exomem/cloud/imports";

/** Fetch alone reports network failures as TypeError; parsing and application errors keep their identity. */
const fetchImport: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof TypeError) throw new ImportStop("CONNECTION");
    throw error;
  }
};

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
  return (await readBrowserImportContext(csrfToken, importId, signal)).import;
}

/** Home reads the same owner-scoped response once for the import and its admission readings. */
export async function readBrowserImportContext(
  csrfToken: string,
  importId?: string,
  signal?: AbortSignal
): Promise<CloudImportReply> {
  assertImportAccount(csrfToken);
  const result = cloudImportReply.parse(
    await getPrivateJson(
      importId ? `${path}/${encodeURIComponent(importId)}` : path,
      signal,
      fetchImport
    )
  );
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
    { csrfToken, signal, fetcher: fetchImport }
  );
  assertImportAccount(csrfToken);
  const result = cloudImportReply.parse(response).import;
  if (!result || result.import_id !== importId) throw new ImportStop("REPLY_MISMATCH");
  return result;
}
