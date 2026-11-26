"use client";

import { useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Collapse } from "@/components/exomem/Transitions";
import type { WhatsNewDay, WhatsNewSectionView } from "./home-view";
import styles from "./home.module.css";

const DRAWER_ID = "home-whats-new";
const OLDER_ID = "home-whats-new-older";

/** "Got it", which reads "Saving…" while the dismissal is on its way and keeps its width. */
function GotIt({
  working,
  onDismiss,
  ghost,
}: {
  working: boolean;
  onDismiss: () => void;
  ghost: boolean;
}) {
  return (
    <Button
      size={ghost ? "panel" : "detail"}
      variant={ghost ? "ghost" : "secondary"}
      working={working}
      onClick={onDismiss}
    >
      <span className={styles.copyLabel}>
        <span className={styles.copyReserve} aria-hidden="true">
          Saving…
        </span>
        <span>{working ? "Saving…" : "Got it"}</span>
      </span>
    </Button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={open ? styles.chevronOpen : styles.chevron} aria-hidden="true">
      ›
    </span>
  );
}

/**
 * The line under the status: when Evermatter last updated and how many changes,
 * which opens the drawer, and "Got it" while the drawer is closed.
 */
export function WhatsNewLine({
  view,
  open,
  working,
  leaving,
  failed,
  onToggle,
  onDismiss,
}: {
  view: WhatsNewSectionView;
  open: boolean;
  /** The dismissal is on its way to the server. */
  working: boolean;
  /** The dismissal saved and the line is about to go: nothing is left to press. */
  leaving: boolean;
  /** The last dismissal did not save; the line stays until one does. */
  failed: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.whatsNewLine}>
      <div className={styles.whatsNewActions}>
        <Button size="line" aria-expanded={open} aria-controls={DRAWER_ID} onClick={onToggle}>
          {view.line}
          <Chevron open={open} />
        </Button>
        {!open && !leaving && <GotIt ghost working={working} onDismiss={onDismiss} />}
      </div>
      {/* Drawn in the gap under the line, so the page below does not move when it appears. */}
      <span className={styles.whatsNewError} role="alert">
        {failed && !open ? "Couldn’t save. Try Got it again." : null}
      </span>
    </div>
  );
}

function Days({ days }: { days: WhatsNewDay[] }) {
  return (
    <ul className={days.length === 1 ? styles.whatsNewOneDay : styles.whatsNewDays}>
      {days.map((day) => (
        <li key={day.key} className={styles.whatsNewDay}>
          <span className={styles.whatsNewDayLabel}>{day.label}</span>
          <ul className={styles.whatsNewNotes}>
            {day.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** The drawer the line opens: the changes by release day, older days folded. */
export function WhatsNewDrawer({
  view,
  open,
  working,
  failed,
  onDismiss,
}: {
  view: WhatsNewSectionView;
  open: boolean;
  working: boolean;
  failed: boolean;
  onDismiss: () => void;
}) {
  const [olderOpen, setOlderOpen] = useState(false);
  return (
    <Collapse open={open} className={styles.whatsNewDrawer}>
      <section id={DRAWER_ID} className={`${styles.panel} ${styles.whatsNewPanel}`}>
        <div className={styles.whatsNewHead}>
          <h2 className={styles.sectionTitle}>{view.title}</h2>
          <span className={styles.whatsNewHeadEnd}>
            {failed && open && (
              <span className={styles.whatsNewError} role="alert">
                Couldn’t save. Try again.
              </span>
            )}
            <GotIt ghost={false} working={working} onDismiss={onDismiss} />
          </span>
        </div>
        <Days days={view.openDays} />
        {view.older && (
          <>
            <div className={styles.whatsNewFold}>
              <span className={styles.rowMeta}>{view.older.label}</span>
              <Button
                variant="ghost"
                aria-expanded={olderOpen}
                aria-controls={OLDER_ID}
                onClick={() => setOlderOpen((value) => !value)}
              >
                {olderOpen ? "Hide" : "Show"}
                <Chevron open={olderOpen} />
              </Button>
            </div>
            <Collapse open={olderOpen}>
              <div id={OLDER_ID}>
                <Days days={view.older.days} />
              </div>
            </Collapse>
          </>
        )}
      </section>
    </Collapse>
  );
}
