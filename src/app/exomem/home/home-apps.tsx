"use client";

import { useEffect, useRef, useState } from "react";
import { AddressField } from "@/components/exomem/AddressField";
import { Button } from "@/components/exomem/Button";
import { SegmentedSwitch } from "@/components/exomem/SegmentedSwitch";
import phone from "@/components/exomem/phone.module.css";
import { INVOLVEMENT_LEVELS, involvementLevel } from "@/components/exomem/involvement-levels";
import type { HomeApp, LevelKey } from "./home-api";
import { count, type Clock } from "./home-format";
import { appGlyph, appMeta, directoryHint } from "./home-view";
import { Section } from "./home-chrome";
import styles from "./home.module.css";

const COPIED_MS = 1800;

type AppsProps = {
  /** Null until the list arrives: nothing about the apps is said before then. */
  apps: readonly HomeApp[] | null;
  /** The list could not be read: say so instead of showing no apps. */
  failed: boolean;
  /** Ended: the apps are off until a new subscription, and nothing can be added. */
  ended: boolean;
  /**
   * Whether a checkout can start, the banner's own condition: only then do the ended
   * lines name resubscribing (design.md (af)).
   */
  checkoutAvailable: boolean;
  disconnected: ReadonlySet<string>;
  onDisconnect: (app: HomeApp) => Promise<boolean>;
  connectorUrl: string | null;
  /** The level the add-app instructions start on: the coding agents level when known. */
  startLevel: LevelKey;
  /** A reviewer account: its apps joined during the review. */
  reviewer: boolean;
  clock: Clock;
};

function AppRow({
  app,
  ended,
  checkoutAvailable,
  off,
  onDisconnect,
  reviewer,
  clock,
}: {
  app: HomeApp;
  ended: boolean;
  checkoutAvailable: boolean;
  off: boolean;
  onDisconnect: (app: HomeApp) => Promise<boolean>;
  reviewer: boolean;
  clock: Clock;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  let meta = appMeta(app, clock, reviewer);
  if (ended)
    meta = checkoutAvailable ? "off for now · reconnects when you resubscribe" : "off for now";
  else if (off) meta = `disconnected · to use it again, connect from ${app.displayName}`;
  else if (failed) meta = "That didn’t finish. Try again in a minute.";
  else if (confirming) meta = "It loses access until you connect it again.";

  async function disconnect() {
    setWorking(true);
    const ok = await onDisconnect(app);
    setWorking(false);
    setConfirming(false);
    setFailed(!ok);
  }

  return (
    <div
      className={`${styles.row} ${styles.appRow} ${ended || off ? styles.dimmed : ""}`}
      data-app-id={app.id}
    >
      <div className={styles.glyph} aria-hidden="true">
        {appGlyph(app)}
      </div>
      <div className={styles.rowText}>
        <span className={styles.rowTitle}>{app.displayName}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </div>
      {!ended && !off && !confirming && (
        <Button
          variant="quiet"
          size="row"
          onClick={() => {
            setFailed(false);
            setConfirming(true);
          }}
          aria-label={`Disconnect ${app.displayName}`}
        >
          Disconnect
        </Button>
      )}
      {!ended && !off && confirming && (
        <span className={styles.rowActions}>
          <Button
            variant="primary"
            size="row"
            working={working}
            onClick={() => void disconnect()}
            aria-label={`Disconnect ${app.displayName} now`}
          >
            Disconnect
          </Button>
          <button type="button" className={styles.rowCancel} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}

function CopyLine({ text, value, label }: { text: string; value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  // "Copied" only once the clipboard took the text; a refusal keeps "Copy".
  const copy = () => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => undefined
    );
  };
  return (
    <div className={styles.copyLine}>
      <span className={styles.copyText}>{text}</span>
      <button
        type="button"
        className={`${styles.copyButton} ${phone.hitArea}`}
        onClick={copy}
        aria-label={copied ? `Copied: ${label}` : `Copy ${label}`}
        aria-live="polite"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function AddAnotherApp({
  apps,
  disconnected,
  connectorUrl,
  startLevel,
}: Pick<AppsProps, "apps" | "disconnected" | "connectorUrl" | "startLevel">) {
  // The pick here only chooses which instructions to copy; it saves nothing.
  const [level, setLevel] = useState<LevelKey>(startLevel);
  const [showFull, setShowFull] = useState(false);
  // A list still loading is not an empty one: no hint names an app until the list arrives.
  const hint = apps && directoryHint(apps, disconnected);
  const chosen = involvementLevel(level);
  return (
    <div className={styles.addPanel} id="home-add-app">
      {hint && (
        <div className={styles.hint}>
          <span>{hint.title}</span>
          <span className={styles.hintText}>{hint.text}</span>
        </div>
      )}
      <span className={styles.addLabel}>Any other app that supports MCP</span>
      <div className={styles.step}>
        <span className={styles.stepNumber}>1</span>
        <span className={styles.stepTitle}>Add this address</span>
        <div className={styles.stepBody}>
          {connectorUrl ? (
            <AddressField
              size="row"
              label="In the app’s connector or MCP settings. It asks you to sign in here."
              address={connectorUrl}
            />
          ) : (
            <span className={styles.hintText}>
              Your address is not available right now. Reload this page in a moment.
            </span>
          )}
        </div>
      </div>
      <div className={styles.step}>
        <span className={styles.stepNumber}>2</span>
        <span className={styles.stepTitle}>
          Pick how much it joins in, then paste the instructions
        </span>
        <div className={styles.stepBody}>
          <span className={styles.hintText}>
            Each level has its own instructions; the text below changes with your pick. Paste it
            into the app’s instructions, or its rules file (AGENTS.md).
          </span>
          <SegmentedSwitch
            size="row"
            label="Instructions for how much it joins in"
            options={INVOLVEMENT_LEVELS.map((option) => ({
              value: option.key,
              label: option.label,
            }))}
            value={level}
            onChange={setLevel}
          />
          <CopyLine
            text={`${chosen.label} instructions · ${count(chosen.block.length)} characters`}
            value={chosen.block}
            label={`the ${chosen.label} instructions`}
          />
          <button
            type="button"
            className={`${styles.textToggle} ${phone.hitArea}`}
            aria-expanded={showFull}
            onClick={() => setShowFull(!showFull)}
          >
            {showFull ? "Hide the full text" : "Read the full text"}
          </button>
          {showFull && <pre className={styles.fullText}>{chosen.block}</pre>}
        </div>
      </div>
    </div>
  );
}

export function ConnectedApps(props: AppsProps) {
  const [open, setOpen] = useState(false);
  // Ended, before the list arrives: nothing is known to show, so no panel yet.
  if (props.ended && props.apps === null && !props.failed)
    return <Section title="Connected apps" />;
  return (
    <Section title="Connected apps">
      {props.failed && (
        <div className={`${styles.row} ${styles.panelNote}`} role="status">
          Your apps can’t be listed right now. Try again in a minute.
        </div>
      )}
      {props.ended && !props.failed && props.apps?.length === 0 && (
        // Ended with no app to list: the board's "off for now" in place of an empty panel
        // (design.md (ag)).
        <div className={`${styles.row} ${styles.panelNote}`}>
          {props.checkoutAvailable
            ? "Off for now. Connect an app when you resubscribe."
            : "Off for now."}
        </div>
      )}
      {props.apps?.map((app) => (
        <AppRow
          key={app.id}
          app={app}
          ended={props.ended}
          checkoutAvailable={props.checkoutAvailable}
          off={props.disconnected.has(app.id)}
          onDisconnect={props.onDisconnect}
          reviewer={props.reviewer}
          clock={props.clock}
        />
      ))}
      {!props.ended && (
        <>
          <div className={`${styles.row} ${styles.appRow} ${styles.addRow}`}>
            <div className={`${styles.glyph} ${styles.glyphAdd}`} aria-hidden="true">
              +
            </div>
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>Add another app</span>
              <span className={styles.rowMeta}>Claude, ChatGPT, or any app that supports MCP</span>
            </div>
            <Button
              size="row"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-controls="home-add-app"
            >
              {open ? "Close" : "Set up"}
            </Button>
          </div>
          {open && (
            <AddAnotherApp
              apps={props.apps}
              disconnected={props.disconnected}
              connectorUrl={props.connectorUrl}
              startLevel={props.startLevel}
            />
          )}
        </>
      )}
    </Section>
  );
}
