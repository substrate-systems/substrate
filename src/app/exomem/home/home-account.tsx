"use client";

import { Button } from "@/components/exomem/Button";
import type { ExportView, PlanView, StorageView } from "./home-view";
import { Section } from "./home-chrome";
import styles from "./home.module.css";

export function PlanAndAccount({
  plan,
  storage,
  email,
  onBilling,
  billingBusy,
}: {
  plan: PlanView;
  storage: StorageView;
  email: string | null;
  onBilling: (kind: "portal" | "checkout") => void;
  billingBusy: boolean;
}) {
  return (
    <Section title="Plan and account">
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{plan.name}</span>
          {plan.meta && <span className={styles.rowMeta}>{plan.meta}</span>}
        </div>
        {plan.action && (
          <Button size="account" working={billingBusy} onClick={() => onBilling(plan.action!.kind)}>
            {plan.action.label}
          </Button>
        )}
      </div>
      <div className={styles.storage}>
        <div className={styles.storageLine}>
          <span className={styles.muted}>Storage</span>
          <span>{storage.state === "known" ? storage.line : "not measured yet"}</span>
        </div>
        {storage.state === "known" && (
          <>
            <div
              className={styles.bar}
              role="img"
              aria-label={`${Math.floor(Math.min(1, storage.fraction) * 100)}% used`}
            >
              <div
                className={`${styles.barFill} ${storage.fraction >= 0.8 ? styles.barFull : ""}`}
                style={{ width: `${Math.min(100, storage.fraction * 100).toFixed(1)}%` }}
              />
            </div>
            <span className={styles.measured}>{storage.measured}</span>
          </>
        )}
      </div>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Email</span>
          <span className={styles.rowMeta}>{email ?? "not available right now"}</span>
        </div>
      </div>
      {plan.note && <div className={styles.panelNote}>{plan.note}</div>}
    </Section>
  );
}

export function YourData({
  exportRow,
  exportBusy,
  exportMessage,
  downloadBusy,
  onExport,
  onDownload,
  deletion,
  onDelete,
}: {
  /** Null while export is not released: the row is left out, not shown dead. */
  exportRow: ExportView | null;
  exportBusy: boolean;
  exportMessage: string | null;
  downloadBusy: boolean;
  onExport: () => void;
  onDownload: (exportId: string) => void;
  /** Whose account this is: an owner may delete it, a reviewer may not; unknown leaves the row out. */
  deletion: "owner" | "reviewer" | null;
  onDelete: () => void;
}) {
  const detail = exportRow?.detail ?? null;
  return (
    <Section title="Your data">
      {exportRow && (
        <>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>Export everything</span>
              <span className={styles.rowBody}>{exportRow.description}</span>
            </div>
            <Button
              variant="primary"
              size="account"
              working={exportBusy || exportRow.busy}
              disabled={exportRow.busy}
              onClick={onExport}
            >
              {exportBusy || exportRow.busy ? "Preparing…" : "Export"}
            </Button>
          </div>
          {exportMessage && (
            <div className={styles.inlineStatus} role="status">
              {exportMessage}
            </div>
          )}
          {detail?.kind === "packing" && (
            <div className={`${styles.detail} ${styles.detailColumn}`} role="status">
              <span className={styles.detailText}>{detail.text}</span>
              <div className={styles.pack} aria-hidden="true">
                <div className={styles.packRun} />
              </div>
            </div>
          )}
          {detail?.kind === "ready" && (
            <div className={styles.detail}>
              <span className={styles.detailLead}>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.detailText}>{detail.text}</span>
              </span>
              <Button
                size="detail"
                working={downloadBusy}
                onClick={() => onDownload(detail.exportId)}
              >
                {downloadBusy ? "Preparing…" : "Download"}
              </Button>
            </div>
          )}
          {detail?.kind === "failed" && (
            <div className={styles.detail}>
              <span className={styles.detailLead}>
                <span className={styles.dot} aria-hidden="true" />
                <span className={`${styles.detailText} ${styles.detailStrong}`}>{detail.text}</span>
              </span>
              <Button size="detail" working={exportBusy} onClick={onExport}>
                Try again
              </Button>
            </div>
          )}
          {detail?.kind === "expired" && (
            <div className={styles.detail}>
              <span className={styles.detailLead}>
                <span className={`${styles.dot} ${styles.dotQuiet}`} aria-hidden="true" />
                <span className={styles.detailText}>{detail.text}</span>
              </span>
            </div>
          )}
        </>
      )}
      {deletion && (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowTitle}>Delete Exomem</span>
            <span className={styles.rowBody}>
              {deletion === "reviewer"
                ? "Not on a reviewer account. We delete it when the review ends."
                : "Removes everything. We email you to confirm."}
            </span>
          </div>
          {deletion === "owner" && (
            <button type="button" className={styles.linkButton} onClick={onDelete}>
              Delete…
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
