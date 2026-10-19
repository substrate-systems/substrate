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
      placement="top"
      phoneFullWidth
    >
      {sent ? (
        <>
          <p className={styles.dialogText}>
            {`Nothing is deleted until you open the link.${lasts} Ignore it and your Exomem stays.`}
          </p>
          <Button size="dialog" onClick={onClose}>
            Done
          </Button>
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
          <Button variant="primary" size="dialog" working={step === "sending"} onClick={onSend}>
            {step === "sending" ? "Sending…" : "Email me a confirmation link"}
          </Button>
          <Button variant="ghost" size="dialog" onClick={onClose}>
            Cancel
          </Button>
        </>
      )}
    </Modal>
  );
}

/** After sign-out: the assistants keep their connections. */
export function SignedOutDialog({ open, onDone }: { open: boolean; onDone: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onDone}
      title="Signed out"
      width={360}
      placement="top"
      phoneFullWidth
    >
      <p className={styles.dialogText}>
        Your assistants stay connected. Signing out only ends this browser’s session.
      </p>
      <Button size="dialog" onClick={onDone}>
        OK
      </Button>
    </Modal>
  );
}
