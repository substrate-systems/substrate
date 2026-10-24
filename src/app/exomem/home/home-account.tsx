"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/exomem/Button";
import { Collapse } from "@/components/exomem/Transitions";
import { HOME_YOUR_DATA_ANCHOR } from "@/lib/exomem/home-anchors";
import type { ExportView, PlanView, StorageView } from "./home-view";
import { Section } from "./home-chrome";
import styles from "./home.module.css";

export function PlanAndAccount({
  plan,
  storage,
  email,
  emailControl,
  onBilling,
  billingBusy,
  billingMessage,
  onStorage,
}: {
  plan: PlanView;
  storage: StorageView;
  email: string | null;
  emailControl?: ReactNode;
  onBilling: (kind: "portal" | "checkout") => void;
  billingBusy: boolean;
  billingMessage: string | null;
  onStorage?: () => void;
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
      <Collapse open={Boolean(plan.action && billingMessage)}>
        <div className={styles.billingStatus} role="alert">
          {billingMessage}
        </div>
      </Collapse>
      <div className={styles.storage}>
        <div className={styles.storageLine}>
          <span className={styles.muted}>Storage</span>
          <span className={styles.storageActions}>
            <span>{storage.state === "known" ? storage.line : "not measured yet"}</span>
            {onStorage && (
              <Button size="panel" onClick={onStorage}>
                Add storage
              </Button>
            )}
          </span>
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
      {emailControl ?? (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowTitle}>Email</span>
            <span className={styles.rowMeta}>{email ?? "not available right now"}</span>
          </div>
        </div>
      )}
      {plan.note && <div className={styles.panelNote}>{plan.note}</div>}
    </Section>
  );
}

export function YourData({
  importControl,
  exportRow,
  exportBusy,
  exportMessage,
  downloadBusy,
  onExport,
  onDownload,
  deletion,
  onDelete,
}: {
  importControl?: ReactNode;
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
  const exportButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (retryButton.current && !retryButton.current.isConnected) {
      exportButton.current?.focus({ preventScroll: true });
      retryButton.current = null;
    }
  }, [detail?.kind]);
  return (
    <Section id={HOME_YOUR_DATA_ANCHOR} title="Your data">
      {importControl}
      {exportRow && (
        <>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>Export everything</span>
              <span className={styles.rowBody}>{exportRow.description}</span>
            </div>
            <Button
              ref={exportButton}
              variant="primary"
              size="account"
              working={exportBusy || exportRow.busy}
              onClick={onExport}
            >
              {exportBusy || exportRow.busy ? "Preparing…" : "Export"}
            </Button>
          </div>
          <Collapse open={Boolean(exportMessage)}>
            <div className={styles.inlineStatus} role="alert">
              {exportMessage}
            </div>
          </Collapse>
          <Collapse open={detail !== null} className={styles.exportDetail}>
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
                  <span className={`${styles.detailText} ${styles.detailStrong}`}>
                    {detail.text}
                  </span>
                </span>
                <Button
                  size="detail"
                  working={exportBusy}
                  onClick={(event) => {
                    retryButton.current = event.currentTarget;
                    onExport();
                  }}
                >
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
          </Collapse>
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
