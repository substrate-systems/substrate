"use client";

import { Button } from "@/components/exomem/Button";
import { Modal } from "@/components/exomem/Modal";
import styles from "./home.module.css";

export type DeleteStep = "ask" | "sending" | "sent" | "failed";

/** Delete asks first; nothing is deleted until the emailed link is opened. */
export function DeleteDialog({
  step,
  linkMinutes,
  onSend,
  onClose,
}: {
  step: DeleteStep | null;
  /** How long the emailed link works, when the server says. */
  linkMinutes: number | null;
  onSend: () => void;
  onClose: () => void;
}) {
  const sent = step === "sent";
  return (
    <Modal
      open={step !== null}
      onClose={onClose}
      title={sent ? "Check your email" : "Delete your Exomem?"}
    >
      {sent ? (
        <>
          <p className={styles.dialogText}>
            Nothing is deleted until you open the link.
            {linkMinutes !== null ? ` It works for ${linkMinutes} minutes.` : ""} Ignore it and your
            Exomem stays.
          </p>
          <Button onClick={onClose}>Done</Button>
        </>
      ) : (
        <>
          <p className={styles.dialogText}>
            This removes your notes, files, backups and keys for good. Export first if you want a
            copy.
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
    <Modal open={open} onClose={onDone} title="Signed out">
      <p className={styles.dialogText}>
        Your assistants stay connected. Signing out only ends this browser’s session.
      </p>
      <Button onClick={onDone}>OK</Button>
    </Modal>
  );
}
