"use client";

import { Button } from "@/components/exomem/Button";
import { Section } from "./home-chrome";
import type { WhatsNewSectionView } from "./home-view";
import styles from "./home.module.css";

export function WhatsNew({
  view,
  working,
  failed,
  onDismiss,
}: {
  view: WhatsNewSectionView;
  /** The dismissal is on its way to the server. */
  working: boolean;
  /** The last dismissal did not save; the section stays until one does. */
  failed: boolean;
  onDismiss: () => void;
}) {
  return (
    <Section title="What’s new">
      {view.releases.map((release) => (
        <div className={styles.row} key={release.key}>
          <div className={styles.rowText}>
            <span className={styles.rowMeta}>{release.label}</span>
            <ul className={styles.whatsNewNotes}>
              {release.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        </div>
      ))}
      <div className={styles.whatsNewFoot}>
        {failed && (
          <span className={styles.rowMeta} role="alert">
            Couldn’t save. Try again.
          </span>
        )}
        <Button size="detail" working={working} onClick={onDismiss}>
          Got it
        </Button>
      </div>
    </Section>
  );
}
