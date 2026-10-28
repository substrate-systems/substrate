import { HostedBrowserError } from "./hosted-browser";
import { importLimit, type ImportLimit } from "../exomem/cloud-import-contract";

/**
 * The route that can still finish a stopped import: resume it, choose the folder again, cancel
 * it and start again, or read its status, which has moved on without this page.
 */
export type ImportStopNext = "resume" | "choose" | "cancel" | "status";

// These are closed browser and C5 protocol codes. The text never carries a file name, a path
// or a browser's message, because those can name private folder content.
const STOPS = {
  FOLDER_EMPTY: { next: "choose", text: "Choose a folder that contains files." },
  FOLDER_SHAPE: { next: "choose", text: "Choose one folder to import." },
  FOLDER_PATH: {
    next: "choose",
    text: "The folder contains an invalid or repeated archive path.",
  },
  BROWSER_SPACE: {
    next: "resume",
    text: "This browser does not have room for the encrypted copy.",
  },
  BROWSER_FULL: {
    next: "resume",
    text: "This browser ran out of room while writing the encrypted copy.",
  },
  BROWSER_BLOCKED: {
    next: "cancel",
    text: "This browser does not let Exomem keep the encrypted copy. Private windows often block it.",
  },
  BROWSER_UNSUPPORTED: {
    next: "cancel",
    text: "This browser cannot write the encrypted copy. Use a current Chrome, Edge, Firefox or Safari.",
  },
  FILE_UNREADABLE: {
    next: "choose",
    text: "A file could not be read. It may have changed or moved after you chose it.",
  },
  LOCAL_COPY_MISSING: {
    next: "cancel",
    text: "This browser no longer has the encrypted copy for this import.",
  },
  LOCAL_COPY_CHANGED: {
    next: "cancel",
    text: "The encrypted copy in this browser does not match the one this import reported.",
  },
  LINKS_EXPIRED: { next: "cancel", text: "The upload links have expired." },
  DESTINATION: { next: "resume", text: "The upload destination is unavailable." },
  PARTS: { next: "cancel", text: "The upload parts do not match the encrypted copy." },
  STORAGE_REFUSED: { next: "resume", text: "Storage did not accept a part of the upload." },
  STORAGE_UNCONFIRMED: { next: "resume", text: "Storage did not confirm a part of the upload." },
  CONNECTION: { next: "resume", text: "The connection dropped." },
  NOT_WAITING: { next: "status", text: "The import is no longer waiting for an upload." },
  UNAVAILABLE: { next: "status", text: "The import is unavailable." },
  KEY_UNAVAILABLE: { next: "resume", text: "The import encryption key is unavailable." },
  REPLY_MISMATCH: { next: "status", text: "The import reply did not match this upload." },
  OTHER_TAB: {
    next: "resume",
    text: "This import is running in another tab or window.",
  },
  IMPORT_TOO_MANY_FILES: {
    next: "choose",
    text: "The folder has more members than this vault accepts. Choose a smaller folder.",
  },
  IMPORT_STORAGE_LIMIT: {
    next: "choose",
    text: "The import cannot fit within this vault’s storage limit. Choose a smaller folder.",
  },
  IMPORT_PARTS_LIMIT: {
    next: "cancel",
    text: "The encrypted copy exceeds this vault’s upload limit.",
  },
  IMPORT_STORAGE_UNAVAILABLE: {
    next: "choose",
    text: "The vault’s storage did not grow in time. Start a new import to try again.",
  },
  IMPORT_STORAGE_NO_ROOM: {
    next: "choose",
    text: "The vault cannot grow its storage right now. Start a new import later.",
  },
  STOPPED: { next: "resume", text: "The browser stopped the import." },
} satisfies Record<string, { next: ImportStopNext; text: string }>;

export type ImportStopCode = keyof typeof STOPS;

export class ImportStop extends Error {
  readonly code: ImportStopCode;
  readonly next: ImportStopNext;
  /** The temporary encrypted file could not be removed after this stop. */
  readonly cleanupFailed: boolean;
  readonly limit?: ImportLimit;

  constructor(
    code: ImportStopCode,
    options: { cleanupFailed?: boolean; limit?: ImportLimit } = {}
  ) {
    super(STOPS[code].text);
    this.name = "ImportStop";
    this.code = code;
    this.next = STOPS[code].next;
    this.cleanupFailed = options.cleanupFailed ?? false;
    this.limit = options.limit;
  }
}

// DOMException names are a closed WebIDL set; each maps to a reason without the browser's text.
const DOM_STOPS: Partial<Record<string, ImportStopCode>> = {
  QuotaExceededError: "BROWSER_FULL",
  SecurityError: "BROWSER_BLOCKED",
  NotAllowedError: "BROWSER_BLOCKED",
  NoModificationAllowedError: "BROWSER_BLOCKED",
  NotReadableError: "FILE_UNREADABLE",
  NotFoundError: "FILE_UNREADABLE",
};

/** Whether the error is the pause signal rather than a failure. */
export function importPaused(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * The content-free reason for a stop, or null for a pause or a server reply. Server replies
 * keep their own content-free codes and wording.
 */
export function importStopFrom(error: unknown): ImportStop | null {
  if (importPaused(error)) return null;
  if (error instanceof HostedBrowserError)
    return Object.hasOwn(STOPS, error.code)
      ? new ImportStop(error.code as ImportStopCode, {
          limit: importLimit.safeParse(error.limit).data,
        })
      : null;
  if (error instanceof ImportStop) return error;
  if (error instanceof AggregateError) {
    const cause = importStopFrom(error.errors[0]);
    return new ImportStop(cause?.code ?? "STOPPED", { cleanupFailed: true });
  }
  if (error instanceof DOMException) return new ImportStop(DOM_STOPS[error.name] ?? "STOPPED");
  return new ImportStop("STOPPED");
}
