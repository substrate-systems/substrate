import type { CloudImport } from "../exomem/cloud-import-contract";
import {
  assertImportAccount,
  requestBrowserImport,
  readBrowserImport,
} from "./cloud-import-browser-api";
import { encryptImportToBrowserFile } from "./cloud-import-browser-file";
import { uploadImportParts, type ImportFile } from "./cloud-import-browser";

export type ImportProgress =
  | { phase: "preparing" | "encrypting" | "reporting" }
  | { phase: "uploading"; bytes: number; total: number };

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

/** One selection owns its randomized ciphertext and receipts until completion or disposal. */
export class BrowserImportUpload {
  readonly id = crypto.randomUUID();
  private encrypted: Awaited<ReturnType<typeof encryptImportToBrowserFile>> | null = null;
  private readonly completed = new Map<number, string>();
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly files: ImportFile[],
    private readonly csrfToken: string
  ) {}

  resume(
    observed: (operation: CloudImport) => void,
    progress: (value: ImportProgress) => void
  ): Promise<void> {
    if (this.active) return this.active;
    const controller = new AbortController();
    this.controller = controller;
    this.active = this.send(observed, progress, controller.signal).finally(() => {
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
    if (this.encrypted) {
      await this.encrypted.remove();
      this.encrypted = null;
    }
  }

  private async send(
    observed: (operation: CloudImport) => void,
    progress: (value: ImportProgress) => void,
    signal: AbortSignal
  ) {
    progress({ phase: "preparing" });
    let operation = await requestBrowserImport(
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
          throw new Error(
            "The import is no longer waiting for an upload. Check its current status."
          );
        }
        if (ready(operation)) return;
        await pauseUntilNextRead(signal);
        const next = await readBrowserImport(this.csrfToken, this.id, signal);
        signal.throwIfAborted();
        if (!next) throw new Error("The import is unavailable. Check its current status.");
        operation = next;
        observed(operation);
      }
    };

    if (!this.encrypted) {
      await waitFor((value) => value.observed_state === "key_ready" && Boolean(value.recipient));
      const recipient = operation.recipient;
      if (!recipient) throw new Error("The import encryption key is unavailable.");
      progress({ phase: "encrypting" });
      this.encrypted = await encryptImportToBrowserFile(this.files, recipient, signal);
    }
    const encrypted = this.encrypted;
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
      throw new Error("The upload links have expired. Cancel this import and start again.");
    }
    assertImportAccount(this.csrfToken);
    progress({ phase: "uploading", bytes: 0, total: encrypted.report.ciphertext_bytes });
    const part_etags = await uploadImportParts(
      encrypted.ciphertext,
      operation.part_urls,
      this.completed,
      (bytes) => {
        assertImportAccount(this.csrfToken);
        progress({ phase: "uploading", bytes, total: encrypted.report.ciphertext_bytes });
      },
      signal
    );
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
}
