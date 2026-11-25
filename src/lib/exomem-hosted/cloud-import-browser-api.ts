import { filingViewReply, type FilingView } from "../exomem/cloud-filing-contract";
import { cloudImportReply, type CloudImport } from "../exomem/cloud-import-contract";
import { ImportStop } from "./cloud-import-stop";
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
  if (!result || result.import_id !== importId) throw new ImportStop("REPLY_MISMATCH");
  return result;
}

/**
 * How far the cell has filed one import. Home's owner channel answers 404 while it is not
 * released; Home then cannot see filing, so it offers the assistant prompt as on an older cell.
 */
export async function readImportFiling(
  csrfToken: string,
  importId: string,
  signal?: AbortSignal
): Promise<FilingView> {
  assertImportAccount(csrfToken);
  let reply: FilingView;
  try {
    reply = filingViewReply.parse(
      await getPrivateJson(`/api/exomem/cloud/home/filing/${encodeURIComponent(importId)}`, signal)
    );
  } catch (error) {
    if (error instanceof HostedBrowserError && error.status === 404)
      return { state: "not_offered" };
    throw error;
  }
  assertImportAccount(csrfToken);
  return reply;
}

/**
 * Registers an import's stage with the cell's filer under this login and wakes it. The cell
 * answers the filing record; Home makes this call only after a read of the filing view.
 */
export async function wakeImportFiling(
  csrfToken: string,
  importId: string,
  signal?: AbortSignal
): Promise<FilingView> {
  assertImportAccount(csrfToken);
  const reply = filingViewReply.parse(
    await postPrivateJson(
      `/api/exomem/cloud/home/filing/${encodeURIComponent(importId)}`,
      {},
      "POST",
      { csrfToken, signal }
    )
  );
  assertImportAccount(csrfToken);
  return reply;
}
