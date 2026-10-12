"use client";

import { Button } from "@/components/exomem/Button";
import { Modal } from "@/components/exomem/Modal";
import styles from "./home.module.css";

export type DeleteStep = "ask" | "sending" | "sent" | "failed";

/** Delete asks first; nothing is deleted until the emailed link is opened. */
export function DeleteDialog({
  step,
  linkMinutes,
  exportOffered,
  onSend,
  onClose,
}: {
  step: DeleteStep | null;
  /** How long the emailed link works, when the server says. */
  linkMinutes: number | null;
  /** False while the export flag is off: support makes the copy (design.md deviation (s)). */
  exportOffered: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  const sent = step === "sent";
  const lasts =
    linkMinutes === null
      ? ""
      : ` It works for ${linkMinutes} minute${linkMinutes === 1 ? "" : "s"}.`;
  return (
    <Modal
      open={step !== null}
      onClose={onClose}
      title={sent ? "Check your email" : "Delete your Exomem?"}
      width={400}
    >
      {sent ? (
        <>
          <p className={styles.dialogText}>
            {`Nothing is deleted until you open the link.${lasts} Ignore it and your Exomem stays.`}
          </p>
          <Button onClick={onClose}>Done</Button>
        </>
      ) : (
        <>
          <p className={styles.dialogText}>
            This removes your notes, files, backups and keys for good.{" "}
            {exportOffered ? (
              "Export first if you want a copy."
            ) : (
              <>
                <a className={styles.inlineButton} href="/exomem/support">
                  Write to support
                </a>{" "}
                first if you want a copy.
              </>
            )}
          </p>
          {step === "failed" && (
            <p className={styles.dialogText} role="alert">
              That didn’t finish. Try again in a minute.
            </p>
          )}
          <div className={styles.dialogActions}>
            <Button variant="primary" size="page" working={step === "sending"} onClick={onSend}>
              {step === "sending" ? "Sending…" : "Email me a confirmation link"}
            </Button>
            <button type="button" className={styles.dialogCancel} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** After sign-out: the assistants keep their connections. */
export function SignedOutDialog({ open, onDone }: { open: boolean; onDone: () => void }) {
  return (
    <Modal open={open} onClose={onDone} title="Signed out" width={360}>
      <p className={styles.dialogText}>
        Your assistants stay connected. Signing out only ends this browser’s session.
      </p>
      <Button onClick={onDone}>OK</Button>
    </Modal>
  );
}
