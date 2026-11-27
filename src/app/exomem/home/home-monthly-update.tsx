"use client";

import { useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Collapse } from "@/components/exomem/Transitions";
import type { MonthlyUpdateEmailView } from "@/lib/exomem-hosted/whats-new-digest/setting";
import { saveMonthlyUpdateEmail, SignedOutError } from "./home-api";
import styles from "./home.module.css";

/**
 * The "Monthly update email" setting (`send-monthly-whats-new-digest`, D5) and
 * the invitation that an owner who existed before the email gets once.
 * The value shown is the server's: after each change Home reads the account
 * again, so it also shows what the unsubscribe link last set.
 */
export function MonthlyUpdateEmail({
  view,
  onSaved,
}: {
  view: MonthlyUpdateEmailView;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState<"toggle" | "dismiss" | null>(null);
  const [failed, setFailed] = useState(false);

  async function save(
    kind: "toggle" | "dismiss",
    change: { enabled: boolean } | { dismissInvitation: true }
  ) {
    setBusy(kind);
    setFailed(false);
    try {
      if (await saveMonthlyUpdateEmail(change)) onSaved();
      else setFailed(true);
    } catch (error) {
      // A signed-out session is Home's to handle on its next read.
      if (!(error instanceof SignedOutError)) setFailed(true);
      else onSaved();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Monthly update email</span>
          <span className={styles.rowMeta}>
            {view.enabled ? "On. Once a month, the changes you are most likely to notice." : "Off"}
          </span>
        </div>
        <Button
          size="account"
          working={busy === "toggle"}
          disabled={busy !== null}
          onClick={() => void save("toggle", { enabled: !view.enabled })}
        >
          {view.enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      {view.invited && (
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowBody}>
              Want a short email once a month with the changes you are most likely to notice? It
              stays off until you turn it on.
            </span>
          </div>
          <button
            type="button"
            className={styles.linkButton}
            disabled={busy !== null}
            onClick={() => void save("dismiss", { dismissInvitation: true })}
          >
            Not now
          </button>
        </div>
      )}
      <Collapse open={failed}>
        <div className={styles.inlineStatus} role="alert">
          That did not save. Try again.
        </div>
      </Collapse>
    </>
  );
}
