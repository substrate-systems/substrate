"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/exomem/Button";
import { Notice } from "@/components/exomem/Notice";
import { SegmentedSwitch } from "@/components/exomem/SegmentedSwitch";
import {
  INVOLVEMENT_LEVELS,
  involvementLevel,
  type InvolvementLevelKey,
} from "@/components/exomem/involvement-levels";
import type { Known } from "@/lib/exomem-hosted/known";
import { consentCopy, joinedCopy, sentCopy, signedInCopy, unknownDate } from "./copy";
import phone from "@/components/exomem/phone.module.css";
import styles from "./journey.module.css";

export function StepHeading({ title, lede }: { title: string; lede: ReactNode }) {
  return (
    <div className={styles.heading}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lede}>{lede}</p>
    </div>
  );
}

/**
 * The step's notice: a muted edge, or amber (`attention`) for a live state that needs
 * the person now. A failed attempt is also an alert, so it is announced.
 */
export function StepNotice({
  children,
  attention = false,
  alert = false,
  id,
}: {
  children: ReactNode;
  attention?: boolean;
  alert?: boolean;
  id?: string;
}) {
  return (
    <div className={styles.notice} id={id} role={alert ? "alert" : undefined}>
      <Notice attention={attention || alert}>{children}</Notice>
    </div>
  );
}

type Action = { label: string; onClick: () => void; disabled?: boolean; working?: boolean };

/** The step's main action, full width, and its quiet second action under it. */
export function StepActions({
  primary,
  secondary,
  primaryType = "button",
}: {
  primary?: Action | null;
  secondary?: Action | null;
  primaryType?: "button" | "submit";
}) {
  if (!primary && !secondary) return null;
  return (
    <div className={styles.actions}>
      {primary ? (
        <div className={styles.primary}>
          <Button
            variant="primary"
            size="page"
            type={primaryType}
            onClick={primaryType === "submit" ? undefined : primary.onClick}
            disabled={primary.disabled}
            working={primary.working}
          >
            {primary.label}
          </Button>
        </div>
      ) : null}
      {secondary ? (
        <Button variant="ghost" onClick={secondary.onClick} disabled={secondary.disabled}>
          {secondary.label}
        </Button>
      ) : null}
    </div>
  );
}

/** Opens an address outside Exomem in a new tab ("Open Claude ↗", "Status page ↗"). */
export function openElsewhere(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * "Signed in as … · Switch account". A desktop repeats the header's email here only
 * on some steps (`onDesktop`); a phone has no header email, so it always shows.
 */
export function SignedInLine({
  email,
  onSwitch,
  onDesktop,
}: {
  email: string;
  onSwitch: () => void;
  onDesktop: boolean;
}) {
  return (
    <div className={onDesktop ? styles.signedIn : `${styles.signedIn} ${styles.phoneOnly}`}>
      {signedInCopy.prefix(email)}
      <button
        type="button"
        className={`${styles.inlineButton} ${phone.hitArea}`}
        onClick={onSwitch}
      >
        {signedInCopy.switchAccount}
      </button>
    </div>
  );
}

/** Something live is happening elsewhere and this page waits for it: a blinking amber dot. */
export function WaitNote({ children }: { children: ReactNode }) {
  return (
    <div className={`${styles.statusLine} ${styles.waiting}`} role="status">
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </div>
  );
}

/** A settled, current state: a still amber dot. */
export function DoneLine({ children }: { children: ReactNode }) {
  return (
    <div className={`${styles.statusLine} ${styles.done}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </div>
  );
}

/** The board's working bar, for a step with nothing to press while the server works. */
export function WorkingBar({ label }: { label: string }) {
  return (
    <div className={styles.working} role="status">
      <div className={styles.workingBar} />
      <span className={styles.status}>{label}</span>
    </div>
  );
}

export function SentCard({ email }: { email: string }) {
  return (
    <div className={`${styles.panel} ${styles.sent}`}>
      <div className={styles.factRow}>
        <span className={styles.factLabel}>{sentCopy.sentTo}</span>
        <span className={styles.factValue}>{email}</span>
      </div>
      <div className={styles.panelNote}>{sentCopy.openHere}</div>
    </div>
  );
}

/**
 * What the app may do, from the scopes the request names (exomem.read and
 * exomem.write, the OAuth server's documented scope set). Read-only accounts keep
 * the save line, struck, with "paused".
 */
export function ScopesCard({ scopes, readOnly }: { scopes: string[]; readOnly: boolean }) {
  const read = scopes.includes("exomem.read");
  const write = scopes.includes("exomem.write");
  const { scopes: copy } = consentCopy;
  return (
    <ul className={`${styles.panel} ${styles.scopes}`}>
      {read ? <ScopeLine text={copy.recall} /> : null}
      {write ? <ScopeLine text={copy.save} paused={readOnly} /> : null}
      {read ? <ScopeLine text={copy.why} /> : null}
      <li className={styles.scopeFootnote}>{copy.footnote}</li>
    </ul>
  );
}

function ScopeLine({ text, paused = false }: { text: string; paused?: boolean }) {
  return (
    <li className={paused ? `${styles.scope} ${styles.scopePaused}` : styles.scope}>
      <span className={styles.scopeMark} aria-hidden="true">
        {paused ? "–" : "✓"}
      </span>
      <span className={styles.scopeText}>{text}</span>
      {paused ? <span className={styles.scopeNote}>{consentCopy.scopes.paused}</span> : null}
    </li>
  );
}

export type Choice = {
  key: string;
  name: string;
  also: string;
  glyph: string;
  cta: string;
  /** Already connected to this Exomem. */
  current: boolean;
  onPick: () => void;
};

export function ChoiceList({ choices }: { choices: Choice[] }) {
  return (
    <div className={styles.choices}>
      {choices.map((choice) => (
        <button key={choice.key} type="button" className={styles.choice} onClick={choice.onPick}>
          <span className={styles.choiceGlyph} aria-hidden="true">
            {choice.glyph}
          </span>
          <span className={styles.choiceText}>
            <span className={styles.choiceName}>{choice.name}</span>
            <span className={styles.choiceAlso}>{choice.also}</span>
          </span>
          <span
            className={choice.current ? `${styles.choiceCta} ${styles.current}` : styles.choiceCta}
          >
            {choice.cta}
          </span>
        </button>
      ))}
    </div>
  );
}

const COPIED_MS = 1800;
const COUNT = new Intl.NumberFormat("en-GB");

/** Pick a level, read what it does, copy its instructions (the joined step for an app without the plugin). */
export function LevelTune({
  level,
  onLevel,
}: {
  level: InvolvementLevelKey;
  onLevel: (level: InvolvementLevelKey) => void;
}) {
  const current = involvementLevel(level);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = () => {
    navigator.clipboard?.writeText(current.block).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {
        // Refused: the block stays on the page, and Home shows it in full.
      }
    );
  };
  return (
    <div className={styles.tune}>
      <SegmentedSwitch
        label={joinedCopy.levelsLabel}
        options={INVOLVEMENT_LEVELS.map((option) => ({ value: option.key, label: option.label }))}
        value={level}
        onChange={(next) => {
          setCopied(false);
          onLevel(next);
        }}
        description={current.description}
      />
      <div className={styles.blockHead}>
        <span>{joinedCopy.instructions(current.label)}</span>
        <span className={styles.blockCount}>
          {joinedCopy.characters(COUNT.format(current.block.length))}
        </span>
      </div>
      <div className={styles.block}>{current.block}</div>
      <div className={styles.pasteRow}>
        <span className={styles.pasteHint}>{joinedCopy.paste}</span>
        <Button onClick={copy} aria-live="polite">
          {copied ? joinedCopy.copied : joinedCopy.copy}
        </Button>
      </div>
    </div>
  );
}

const noChange = () => () => {};

function dayMonth(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone }).format(
    new Date(iso)
  );
}

/**
 * A date as the board writes it ("10 November"), in the reader's own time zone.
 * The server renders before it knows that zone, so it writes the UTC date and the
 * browser replaces it as soon as the page hydrates. Unknown is said in words.
 */
export function useReaderDate(date: Known<string>): string {
  return useSyncExternalStore(
    noChange,
    () => (date.value === null ? unknownDate : dayMonth(date.value, undefined)),
    () => (date.value === null ? unknownDate : dayMonth(date.value, "UTC"))
  );
}
