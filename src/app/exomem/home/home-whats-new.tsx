"use client";

import { useId, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Collapse } from "@/components/exomem/Transitions";
import type { WhatsNewItem, WhatsNewSectionView } from "./home-view";
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

/** One change: its title opens the full sentence underneath. A note with no title shows its sentence. */
function Change({ item }: { item: WhatsNewItem }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (item.title === null) {
    return (
      <li className={styles.whatsNewItem}>
        <p className={styles.whatsNewUntitled}>{item.text}</p>
      </li>
    );
  }
  return (
    <li className={styles.whatsNewItem}>
      <button
        type="button"
        className={styles.whatsNewTitle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{item.title}</span>
        <Chevron open={open} />
      </button>
      <Collapse open={open}>
        <p id={id} className={styles.whatsNewText}>
          {item.text}
        </p>
      </Collapse>
    </li>
  );
}

function Changes({ items }: { items: WhatsNewItem[] }) {
  return (
    <ul className={styles.whatsNewList}>
      {items.map((item) => (
        <Change key={item.key} item={item} />
      ))}
    </ul>
  );
}

/** The drawer the line opens: one title per change, newest days first, older days folded. */
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
        <Changes items={view.items} />
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
                <Changes items={view.older.items} />
              </div>
            </Collapse>
          </>
        )}
      </section>
    </Collapse>
  );
}
