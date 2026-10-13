"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import { FlowField, type FieldKind } from "@/components/exomem/FlowField";
import { PairedTiles } from "@/components/exomem/PairedTiles";
import { Wordmark } from "@/components/exomem/Wordmark";
import { CLIENT_PLATFORM_NAMES } from "@/lib/exomem-hosted/client-platforms";
import phone from "@/components/exomem/phone.module.css";
import styles from "./journey.module.css";

/** The app tile: its glyph is a mark, not a logo, and its name is the tile's title. */
export type AppTile = { name: string; glyph: ReactNode; glyphSize: number };

/** The tile for an app, from its platform and where its codes go (the board's APPS). */
export function appTile(app: { displayName: string; platform: string | null; loopback: boolean }) {
  // A loopback app runs in a terminal on this computer: Claude Code, Codex or any CLI.
  if (app.loopback) return { name: app.displayName, glyph: ">_", glyphSize: 17 };
  // `platform` is the closed client_platform set (claude | openai).
  if (app.platform === "claude" || app.platform === "openai") {
    const Icon = app.platform === "claude" ? Sparkles : MessageCircle;
    return {
      name: app.displayName,
      glyph: (
        <span className={styles.platformGlyph}>
          <Icon size={22} />
          <span>{CLIENT_PLATFORM_NAMES[app.platform]}</span>
        </span>
      ),
      glyphSize: 10,
    };
  }
  return { name: app.displayName, glyph: "MCP", glyphSize: 12 };
}

/** What the page's tiles and field show, from the step (phaseOf() and kindOf() in the board). */
function tilesState(kind: FieldKind): "idle" | "connecting" | "connected" | "stopped" {
  if (kind === "go") return "connecting";
  if (kind === "done") return "connected";
  if (kind === "stop") return "stopped";
  return "idle";
}

type JourneyPageProps = {
  kind: FieldKind;
  /** The app that opened the page; none when the person started on our site. */
  app?: AppTile;
  /** Signed in: the email in the header (desktop). */
  headerEmail?: string | null;
  /** The signed-in navigation destination can differ from the visible email. */
  homeHref?: string;
  centered?: boolean;
  /** A page an app opened: where the request came from. */
  footer?: string | null;
  /**
   * The board lights the tiles from the step's phase (phaseOf()), which is connected only
   * once an app has connected. A settled change that connects no app, such as a friend
   * price added, settles the field but keeps the tiles idle: the mark stays grey.
   */
  tilesIdle?: boolean;
  /** Changes when the flow shows a new step. */
  stepKey: string;
  /** A person started this transition; initial loading leaves focus alone. */
  focusHeading?: boolean;
  /** None while the page waits for its first answer. */
  children?: ReactNode;
};

export function JourneyPage({
  kind,
  app,
  headerEmail,
  homeHref = headerEmail ? "/exomem/home" : "/exomem",
  centered = false,
  footer,
  tilesIdle = false,
  stepKey,
  focusHeading = false,
  children,
}: JourneyPageProps) {
  const content = useRef<HTMLDivElement>(null);
  const previousStep = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusHeading && previousStep.current !== stepKey) {
      content.current?.querySelector("h1")?.focus({ preventScroll: true });
    }
    previousStep.current = stepKey;
  }, [stepKey, focusHeading]);
  return (
    <main className={`${styles.page} brand-exomem`}>
      <FlowField kind={kind} footer={!!footer} />
      <a className={`${styles.wordmark} ${phone.hitArea}`} href={homeHref} aria-label="Exomem home">
        <Wordmark />
      </a>
      {headerEmail ? <div className={styles.headerEmail}>{headerEmail}</div> : null}
      <div className={`${styles.center} ${centered ? styles.centered : ""}`}>
        <div className={styles.column}>
          <div className={styles.tiles}>
            <PairedTiles state={tilesIdle ? "idle" : tilesState(kind)} app={app} />
          </div>
          <div className={styles.content} ref={content}>
            {children}
          </div>
        </div>
      </div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </main>
  );
}
