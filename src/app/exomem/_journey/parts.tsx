"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/exomem/Button";
import { Notice } from "@/components/exomem/Notice";
import { SegmentedSwitch } from "@/components/exomem/SegmentedSwitch";
import {
  INVOLVEMENT_LEVELS,
  involvementLevel,
  type InvolvementLevelKey,
} from "@/components/exomem/involvement-levels";
import { breakCopy, claimCopy, consentCopy, joinedCopy, sentCopy, signedInCopy } from "./copy";
import phone from "@/components/exomem/phone.module.css";
import styles from "./journey.module.css";

export function StepHeading({ title, lede }: { title: string; lede: ReactNode }) {
  return (
    <div className={styles.heading}>
      <h1 className={styles.title} tabIndex={-1}>
        {title}
      </h1>
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
  visible = true,
}: {
  children: ReactNode;
  /** Keep the message's space before an attempt, and while it retries. */
  visible?: boolean;
  attention?: boolean;
  alert?: boolean;
  id?: string;
}) {
  return (
    <div
      className={alert ? `${styles.notice} ${styles.errorNotice}` : styles.notice}
      id={id}
      role={alert && visible ? "alert" : undefined}
      style={visible ? undefined : { visibility: "hidden" }}
      aria-hidden={!visible || undefined}
    >
      {alert ? (
        children
      ) : (
        <Notice attention={attention} size="flow">
          {children}
        </Notice>
      )}
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
        <Button
          variant="ghost"
          size="page"
          onClick={secondary.onClick}
          disabled={secondary.disabled}
          working={secondary.working}
        >
          {secondary.label}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The ended step's lede (Journey board). It names resubscribing, and the friend price that
 * comes back with it, only while checkout can start; it names the export only while the
 * export flag is on (design.md (s) and (af)).
 */
export function endedLede({
  until,
  app,
  exportOffered,
  checkoutAvailable,
  inviter,
}: {
  until: string;
  app: string;
  exportOffered: boolean;
  checkoutAvailable: boolean;
  inviter: string | null;
}): string {
  const copy = breakCopy.ended;
  if (!checkoutAvailable) return copy.ledeWithoutCheckout(until, exportOffered);
  return (
    (exportOffered ? copy.lede(until, app) : copy.ledeWithoutExport(until, app)) +
    (inviter ? copy.friendBack(inviter) : "")
  );
}

/**
 * The ended step's actions (Journey board): "Resubscribe", the checkout Home's ended banner
 * starts, and the export action under it. Without a checkout to start, the export action
 * is the step's only action (design.md (af)).
 */
export function EndedActions({
  resubscribe,
  exportMemory,
}: {
  /** The page's checkout, or null when the account cannot start one now. */
  resubscribe: { subscribe: () => Promise<void>; opening: boolean } | null;
  exportMemory: Action;
}) {
  return resubscribe ? (
    <StepActions
      primary={{
        label: breakCopy.ended.resubscribe,
        working: resubscribe.opening,
        onClick: () => void resubscribe.subscribe(),
      }}
      secondary={exportMemory}
    />
  ) : (
    <StepActions primary={exportMemory} />
  );
}

/** A friend's note on their invitation, and their name under it. */
export function InviteNote({ note, by }: { note: string; by: string }) {
  return (
    <figure className={styles.inviteNote}>
      <blockquote className={styles.inviteNoteText}>“{note}”</blockquote>
      <figcaption className={styles.inviteNoteBy}>{by}</figcaption>
    </figure>
  );
}

/** What an invitation costs: who it is from, the amount, and how long it lasts. */
export function PriceCard({
  label,
  main,
  was,
  note,
}: {
  label: string;
  main: string;
  was: string | null;
  note: string;
}) {
  return (
    <div className={`${styles.panel} ${styles.price}`}>
      <span className={styles.priceLabel}>{label}</span>
      <div className={styles.priceRow}>
        <span className={styles.priceMain}>{main}</span>
        {was ? <s className={styles.priceWas}>{was}</s> : null}
      </div>
      <span className={styles.priceNote}>{note}</span>
    </div>
  );
}

/** Opens an address outside Exomem in a new tab ("Open Claude ↗", "Status page ↗"). */
export function openElsewhere(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** How many characters of an address's local part stay visible however long its domain is. */
const KEPT_LOCAL_CHARACTERS = 6;

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
  // At most two lines at any email length: the line breaks only before "Switch account",
  // and an address too long for its line gives way, its local part first, then its domain.
  // The local part keeps room for its first characters, so a long domain cannot hide whose
  // account this is. The text keeps the whole address for screen readers, and the title
  // shows it on hover (design.md (ai)).
  const at = email.lastIndexOf("@");
  const local = at < 0 ? email : email.slice(0, at);
  const domain = at < 0 ? "" : email.slice(at);
  // Firefox before 125 has no Intl.Segmenter; code points only count a combined letter twice.
  const characters =
    typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter().segment(local)).length
      : Array.from(local).length;
  const longLocal = characters > KEPT_LOCAL_CHARACTERS;
  return (
    <div
      className={onDesktop ? styles.signedIn : `${styles.signedIn} ${styles.phoneOnly}`}
      title={email}
    >
      <span className={styles.signedInWho}>
        <span className={styles.signedInFixed}>{signedInCopy.prefix}</span>
        <span className={styles.signedInAddress}>
          <span
            className={longLocal ? styles.signedInLocal : styles.signedInLocalWhole}
            style={longLocal ? { minWidth: `${KEPT_LOCAL_CHARACTERS}ch` } : undefined}
          >
            {local}
          </span>
          <span className={styles.signedInDomain}>{domain}</span>
        </span>
        <span className={styles.signedInFixed}>{signedInCopy.separator}</span>
      </span>
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
export function ScopesCard({
  scopes,
  readOnly,
  claimedName,
}: {
  scopes: string[];
  readOnly: boolean;
  claimedName?: string | null;
}) {
  const read = scopes.includes("exomem.read");
  const write = scopes.includes("exomem.write");
  const { scopes: copy } = consentCopy;
  return (
    <ul className={`${styles.panel} ${styles.scopes}`}>
      {read ? <ScopeLine text={copy.recall} /> : null}
      {write ? <ScopeLine text={copy.save} paused={readOnly} /> : null}
      {read ? <ScopeLine text={copy.why} /> : null}
      <li className={styles.scopeFootnote}>
        {copy.footnote}
        {claimedName ? (
          <>
            <br />
            <span>{claimCopy(claimedName)}</span>
          </>
        ) : null}
      </li>
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
  saveNote = null,
}: {
  level: InvolvementLevelKey;
  onLevel: (level: InvolvementLevelKey) => void;
  /** Whether the pick was saved, in words; one quiet line, so the step still fits a phone. */
  saveNote?: string | null;
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
      <p className={styles.saveNote} role="status">
        {saveNote ?? "\u00a0"}
      </p>
      <div className={styles.blockHead}>
        <span>{joinedCopy.instructions(current.label)}</span>
        <span className={styles.blockCount}>
          {joinedCopy.characters(COUNT.format(current.block.length))}
        </span>
      </div>
      <div className={styles.block}>{current.block}</div>
      <div className={styles.pasteRow}>
        <span className={styles.pasteHint}>{joinedCopy.paste}</span>
        {/* The board's block copy button: min-width 112, the shared detail size. */}
        <Button size="detail" onClick={copy} aria-live="polite">
          {copied ? joinedCopy.copied : joinedCopy.copy}
        </Button>
      </div>
    </div>
  );
}
