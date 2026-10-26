import { cloudImportFinished, type CloudImport } from "../exomem/cloud-import-contract";
import {
  assertImportAccount,
  requestBrowserImport,
  readBrowserImport,
} from "./cloud-import-browser-api";
import {
  browserStorageRoom,
  encryptImportToBrowserFile,
  holdImport,
  keepImportCiphertext,
  removeFreeImportCiphertext,
  removeImportCiphertext,
  storedImportCiphertext,
  readImportPartReceipts,
  writeImportPartReceipts,
  sweepKeptCiphertext,
  type StoredCiphertext,
} from "./cloud-import-browser-file";
import {
  digestImportCiphertext,
  forecastImport,
  uploadImportParts,
  type ImportFile,
} from "./cloud-import-browser";
import { ImportStop } from "./cloud-import-stop";
import { HostedBrowserError } from "./hosted-browser";

/** Every count is measured from the work itself; totals come from the exact forecast. */
export type ImportProgress =
  /** linking: the encrypted copy is reported and the cell is issuing its upload links. */
  | { phase: "preparing" | "linking" | "reporting" }
  | {
      phase: "encrypting";
      files: number;
      totalFiles: number;
      plaintextBytes: number;
      totalPlaintextBytes: number;
      ciphertextBytes: number;
      totalCiphertextBytes: number;
    }
  | { phase: "verifying" | "uploading"; bytes: number; total: number };

function pauseUntilNextRead(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, 2500);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Whether a kept copy can no longer serve its import, from a fresh read: the import is absent,
 * or it no longer waits for this browser's upload. A failed read keeps the copy.
 */
export async function keptCopyRetired(csrfToken: string, importId: string): Promise<boolean> {
  try {
    const operation = await readBrowserImport(csrfToken, importId);
    // C5's "requested" intent is the only one that still waits for a browser upload.
    return (
      !operation || operation.requested_state !== "requested" || cloudImportFinished(operation)
    );
  } catch (error) {
    return error instanceof HostedBrowserError && error.status === 404;
  }
}

/** The kept file vanished or changed under the page; only that copy is lost, not the folder. */
function keptCopyLost(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "NotReadableError")
  );
}

/**
 * One import's upload from this browser. A new selection starts an import; an existing import
 * continues from the same folder chosen again (before its ciphertext report) or from the
 * ciphertext this browser kept (after it).
 */
export class BrowserImportUpload {
  readonly id: string;
  private encrypted: StoredCiphertext | null = null;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;

  private readonly files: ImportFile[] | null;
  private readonly csrfToken: string;
  private readonly account: string;

  constructor(options: {
    /** The folder to encrypt; null continues from the ciphertext this browser kept. */
    files: ImportFile[] | null;
    csrfToken: string;
    /** The account's stable key, which names its own folder of kept copies. */
    account: string;
    /** An open import to continue; a new import gets a new ID. */
    importId?: string;
  }) {
    this.files = options.files;
    this.csrfToken = options.csrfToken;
    this.account = options.account;
    this.id = options.importId ?? crypto.randomUUID();
  }

  resume(
    observed: (operation: CloudImport) => void,
    progress: (value: ImportProgress) => void
  ): Promise<void> {
    if (this.active) return this.active;
    const controller = new AbortController();
    this.controller = controller;
    this.active = holdImport(this.id, () =>
      this.send(observed, progress, controller.signal)
    ).finally(() => {
      this.active = null;
      this.controller = null;
    });
    return this.active;
  }

  pause() {
    this.controller?.abort();
  }

  async dispose() {
    this.pause();
    // Reap the producer and upload before removing their private ciphertext file.
    await this.active?.catch(() => {});
    this.encrypted = null;
    // A tab that holds the import keeps its copy; a later sweep removes it once the import ends.
    await removeFreeImportCiphertext(this.account, this.id);
  }

  private async send(
    observed: (operation: CloudImport) => void,
    progress: (value: ImportProgress) => void,
    signal: AbortSignal
  ) {
    progress({ phase: "preparing" });
    let operation: CloudImport;
    if (this.files) {
      // Creation is idempotent for the same ID and declaration, so a resumed import re-creates.
      operation = await requestBrowserImport(
        this.csrfToken,
        this.id,
        "create",
        {
          kind: "adopt",
          declared_bytes: this.files.reduce((total, { file }) => total + file.size, 0),
          declared_files: this.files.length,
        },
        signal
      );
    } else {
      const current = await readBrowserImport(this.csrfToken, this.id, signal);
      if (!current) throw new ImportStop("UNAVAILABLE");
      operation = current;
    }
    observed(operation);
    signal.throwIfAborted();
    if (operation.requested_state !== "requested") {
      if (this.encrypted) {
        await this.encrypted.remove();
        this.encrypted = null;
      }
      return;
    }

    const waitFor = async (ready: (value: CloudImport) => boolean) => {
      for (;;) {
        signal.throwIfAborted();
        // These are C5 protocol observations, fixed by migration 0061.
        if (
          operation.requested_state !== "requested" ||
          (operation.observed_state !== "pending" && operation.observed_state !== "key_ready")
        ) {
          throw new ImportStop("NOT_WAITING");
        }
        if (ready(operation)) return;
        await pauseUntilNextRead(signal);
        const next = await readBrowserImport(this.csrfToken, this.id, signal);
        signal.throwIfAborted();
        if (!next) throw new ImportStop("UNAVAILABLE");
        operation = next;
        observed(operation);
      }
    };

    if (
      this.encrypted &&
      operation.ciphertext_sha256 !== null &&
      (this.encrypted.report.ciphertext_sha256 !== operation.ciphertext_sha256 ||
        this.encrypted.report.ciphertext_bytes !== operation.ciphertext_bytes)
    ) {
      // Another page reported different ciphertext; this page's copy cannot continue it.
      this.encrypted = null;
    }
    if (!this.encrypted && operation.ciphertext_sha256 !== null) {
      // The report is fixed; only the ciphertext it describes can continue this import.
      this.encrypted = await this.verifyStored(operation, progress, signal);
    }
    if (!this.encrypted) {
      if (!this.files) throw new ImportStop("LOCAL_COPY_MISSING");
      await waitFor((value) => value.observed_state === "key_ready" && Boolean(value.recipient));
      const recipient = operation.recipient;
      if (!recipient) throw new ImportStop("KEY_UNAVAILABLE");
      // This tab holds the import, so its earlier copy can go; other copies go only when their
      // imports have ended. A copy that stays is counted as used by the space check below.
      await removeImportCiphertext(this.account, this.id).catch(() => {});
      await sweepKeptCiphertext(this.account, this.id, (id) =>
        keptCopyRetired(this.csrfToken, id)
      ).catch(() => {});
      const forecast = await forecastImport(this.files, recipient, signal);
      const room = await browserStorageRoom();
      if (room && room.quota - room.usage < forecast.ciphertextBytes)
        throw new ImportStop("BROWSER_SPACE");
      await keepImportCiphertext();
      const totals = {
        totalFiles: forecast.files,
        totalPlaintextBytes: forecast.plaintextBytes,
        totalCiphertextBytes: forecast.ciphertextBytes,
      };
      progress({ phase: "encrypting", files: 0, plaintextBytes: 0, ciphertextBytes: 0, ...totals });
      this.encrypted = await encryptImportToBrowserFile(
        this.account,
        this.id,
        this.files,
        recipient,
        signal,
        (measured) => progress({ phase: "encrypting", ...measured, ...totals })
      );
    }
    const encrypted = this.encrypted;
    progress({ phase: "linking" });
    operation = await requestBrowserImport(
      this.csrfToken,
      this.id,
      "prepare-upload",
      encrypted.report,
      signal
    );
    observed(operation);
    await waitFor((value) => Boolean(value.part_urls?.length));
    if (
      !operation.part_urls ||
      !operation.urls_expire_at ||
      Date.parse(operation.urls_expire_at) <= Date.now()
    ) {
      throw new ImportStop("LINKS_EXPIRED");
    }
    assertImportAccount(this.csrfToken);
    const completed = await readImportPartReceipts(
      this.account,
      this.id,
      encrypted.report.ciphertext_sha256
    );
    progress({ phase: "uploading", bytes: 0, total: encrypted.report.ciphertext_bytes });
    const part_etags = await uploadImportParts(
      encrypted.ciphertext,
      operation.part_urls,
      completed,
      (bytes) => {
        assertImportAccount(this.csrfToken);
        progress({ phase: "uploading", bytes, total: encrypted.report.ciphertext_bytes });
      },
      signal,
      (part) =>
        writeImportPartReceipts(
          this.account,
          this.id,
          encrypted.report.ciphertext_sha256,
          [...completed].map(([part_number, etag]) => ({ part_number, etag })).concat(part)
        )
    ).catch((error: unknown) => {
      // This page's copy can no longer serve the import; a later attempt looks for it afresh.
      if (error instanceof ImportStop && error.code === "LOCAL_COPY_MISSING") this.encrypted = null;
      throw error;
    });
    signal.throwIfAborted();
    progress({ phase: "reporting" });
    operation = await requestBrowserImport(
      this.csrfToken,
      this.id,
      "complete",
      {
        ...encrypted.report,
        part_etags,
      },
      signal
    );
    observed(operation);
    await encrypted.remove();
    this.encrypted = null;
  }

  /** Checks this browser's kept ciphertext against the import's fixed report before reuse. */
  private async verifyStored(
    operation: CloudImport,
    progress: (value: ImportProgress) => void,
    signal: AbortSignal
  ): Promise<StoredCiphertext> {
    const stored = await storedImportCiphertext(this.account, this.id);
    if (!stored || stored.ciphertext.size === 0) throw new ImportStop("LOCAL_COPY_MISSING");
    const total = stored.ciphertext.size;
    if (total !== operation.ciphertext_bytes) throw new ImportStop("LOCAL_COPY_CHANGED");
    progress({ phase: "verifying", bytes: 0, total });
    const report = await digestImportCiphertext(
      stored.ciphertext,
      (bytes) => progress({ phase: "verifying", bytes, total }),
      signal
    ).catch((error: unknown) => {
      throw keptCopyLost(error) ? new ImportStop("LOCAL_COPY_MISSING") : error;
    });
    if (report.ciphertext_sha256 !== operation.ciphertext_sha256)
      throw new ImportStop("LOCAL_COPY_CHANGED");
    return { ...stored, report };
  }
}
