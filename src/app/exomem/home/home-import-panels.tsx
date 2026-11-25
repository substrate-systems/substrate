"use client";

import { Button } from "@/components/exomem/Button";
import { Notice } from "@/components/exomem/Notice";
import type { ImportForecast } from "@/lib/exomem-hosted/cloud-import-browser";
import type { ImportProgress } from "@/lib/exomem-hosted/cloud-import-browser-upload";
import type { SelectionTotals } from "@/lib/exomem-hosted/cloud-import-selection";
import type { HomeStorage } from "./home-api";
import { ago, byteSize, count } from "./home-format";
import styles from "./home.module.css";
import dialog from "./home-storage.module.css";

export type BrowserRoom = { quota: number; usage: number } | null;

function totals({ files, bytes }: SelectionTotals): string {
  return `${count(files)} file${files === 1 ? "" : "s"} · ${byteSize(bytes)}`;
}

/** Free bytes in the vault from the last disk reading, or null when none is known. */
function vaultFree(storage: HomeStorage | null) {
  if (storage?.state !== "known") return null;
  return {
    bytes: Math.max(0, storage.filesystem_bytes - storage.used_bytes),
    observedAt: storage.observed_at,
  };
}

/** The bytes the browser may still store for this site, or null when it cannot say. */
export function browserFree(room: BrowserRoom): number | null {
  return room ? Math.max(0, room.quota - room.usage) : null;
}

/** The selection beside every limit Home can measure before the upload starts. */
export function ImportLimits({
  forecast,
  room,
  others,
  storage,
  now,
  discarding,
  onDiscardOthers,
}: {
  forecast: ImportForecast;
  room: BrowserRoom;
  /** Kept copies outside this account's folder; null when they could not be read. */
  others: SelectionTotals | null;
  storage: HomeStorage | null;
  now: number;
  discarding: boolean;
  onDiscardOthers: () => void;
}) {
  const browser = browserFree(room);
  const vault = vaultFree(storage);
  return (
    <>
      <dl className={dialog.totals}>
        <div>
          <dt>Encrypted copy</dt>
          <dd>{byteSize(forecast.ciphertextBytes)}</dd>
        </div>
        <div>
          <dt>Free in this browser</dt>
          <dd>{browser === null ? "unknown" : byteSize(browser)}</dd>
        </div>
        <div>
          <dt>Free in your vault</dt>
          <dd>
            {vault === null
              ? "not measured yet"
              : `${byteSize(vault.bytes)}, measured ${ago(vault.observedAt, now)}`}
          </dd>
        </div>
        {others === null ? (
          <div>
            <dt>Other kept copies</dt>
            <dd>unknown</dd>
          </div>
        ) : (
          others.files > 0 && (
            <div>
              <dt>Other kept copies</dt>
              <dd>{totals(others)}</dd>
            </div>
          )
        )}
      </dl>
      {others !== null && others.files > 0 && (
        <>
          <p className={dialog.text}>
            Other accounts, or earlier versions of this page, kept these encrypted copies in this
            browser. Discarding a copy whose import is still open means that import must start
            again.
          </p>
          <Button size="dialog" working={discarding} onClick={onDiscardOthers}>
            {discarding ? "Discarding other copies…" : "Discard other kept copies"}
          </Button>
        </>
      )}
      {browser !== null && browser < forecast.ciphertextBytes && (
        <Notice attention>
          The encrypted copy needs {byteSize(forecast.ciphertextBytes)}, and this browser can store{" "}
          {byteSize(browser)} more for this site. Free space on this device, or use a browser with
          more room, then choose the files again.
        </Notice>
      )}
      {vault !== null && vault.bytes < forecast.plaintextBytes && (
        <Notice>
          Your vault had {byteSize(vault.bytes)} free when it was measured{" "}
          {ago(vault.observedAt, now)}, and this selection adds{" "}
          {byteSize(forecast.plaintextBytes)}. Evermatter may stop the import while it stages the
          files. Add storage first, or choose fewer files.
        </Notice>
      )}
    </>
  );
}

export function Meter({ value, total, label }: { value: number; total: number; label: string }) {
  const fraction = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div
      className={styles.bar}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(fraction * 100)}
    >
      <div className={styles.barFill} style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
    </div>
  );
}

function progressTitle(progress: ImportProgress): string {
  switch (progress.phase) {
    case "preparing":
      return "Preparing the import…";
    case "linking":
      return "Waiting for the upload links…";
    case "encrypting":
      return "Encrypting on this device…";
    case "verifying":
      return "Checking this browser’s encrypted copy…";
    case "uploading":
      return "Uploading the encrypted copy…";
    case "reporting":
      return "Confirming the upload…";
  }
}

/** The work in progress, measured from the work itself. */
export function ImportProgressView({ progress }: { progress: ImportProgress }) {
  return (
    <>
      <p className={dialog.text} role="status">
        {progressTitle(progress)}
      </p>
      {progress.phase === "encrypting" && (
        <>
          <Meter
            value={progress.ciphertextBytes}
            total={progress.totalCiphertextBytes}
            label="Encrypted"
          />
          <dl className={dialog.totals}>
            <div>
              <dt>Files</dt>
              <dd>
                {count(progress.files)} of {count(progress.totalFiles)}
              </dd>
            </div>
            <div>
              <dt>Read</dt>
              <dd>
                {byteSize(progress.plaintextBytes)} of {byteSize(progress.totalPlaintextBytes)}
              </dd>
            </div>
            <div>
              <dt>Encrypted</dt>
              <dd>
                {byteSize(progress.ciphertextBytes)} of {byteSize(progress.totalCiphertextBytes)}
              </dd>
            </div>
          </dl>
        </>
      )}
      {(progress.phase === "verifying" || progress.phase === "uploading") && (
        <>
          <Meter
            value={progress.bytes}
            total={progress.total}
            label={progress.phase === "verifying" ? "Checked" : "Uploaded"}
          />
          <dl className={dialog.totals}>
            <div>
              <dt>{progress.phase === "verifying" ? "Checked" : "Uploaded"}</dt>
              <dd>
                {byteSize(progress.bytes)} of {byteSize(progress.total)}
              </dd>
            </div>
          </dl>
        </>
      )}
    </>
  );
}

/** What support needs to find a stopped import; neither value names any file. */
export function ImportReference({ importId, code }: { importId: string; code?: string }) {
  return (
    <dl className={dialog.totals}>
      <div>
        <dt>Import ID</dt>
        <dd className={dialog.reference}>{importId}</dd>
      </div>
      {code && (
        <div>
          <dt>Reason</dt>
          <dd className={dialog.reference}>{code}</dd>
        </div>
      )}
    </dl>
  );
}

/** A staged import beside the vault reading: filing copies it, so it then counts twice. */
export function StagedImportStorage({
  stagedBytes,
  storage,
  now,
}: {
  stagedBytes: number;
  storage: HomeStorage | null;
  now: number;
}) {
  return (
    <>
      <dl className={dialog.totals}>
        <div>
          <dt>Staged originals</dt>
          <dd>{byteSize(stagedBytes)}</dd>
        </div>
        <div>
          <dt>Your vault</dt>
          <dd>
            {storage?.state === "known"
              ? `${byteSize(storage.used_bytes)} of ${byteSize(storage.filesystem_bytes)} used, measured ${ago(storage.observed_at, now)}`
              : "not measured yet"}
          </dd>
        </div>
      </dl>
      <p className={dialog.text}>
        Filing makes separate copies as Sources, so the staged originals then take space a second
        time. Remove them once your assistant has filed what you want to keep.
      </p>
    </>
  );
}
