import type { ReactNode } from "react";
import { FlowField, type FieldKind } from "@/components/exomem/FlowField";
import { PairedTiles } from "@/components/exomem/PairedTiles";
import { Wordmark } from "@/components/exomem/Wordmark";
import styles from "./journey.module.css";

/** The app tile: its glyph is a mark, not a logo, and its name is the tile's title. */
export type AppTile = { name: string; glyph: string; glyphSize: number };

/** The tile for an app, from its platform and where its codes go (the board's APPS). */
export function appTile(app: { displayName: string; platform: string | null; loopback: boolean }) {
  // A loopback app runs in a terminal on this computer: Claude Code, Codex or any CLI.
  if (app.loopback) return { name: app.displayName, glyph: ">_", glyphSize: 17 };
  // `platform` is the closed client_platform set (claude | openai).
  if (app.platform === "claude") return { name: app.displayName, glyph: "C", glyphSize: 20 };
  if (app.platform === "openai") return { name: app.displayName, glyph: "G", glyphSize: 20 };
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
  /** A page an app opened: where the request came from. */
  footer?: string | null;
  /** Changes with the step, so each step's content fades in. */
  stepKey: string;
  /** None while the page waits for its first answer. */
  children?: ReactNode;
};

export function JourneyPage({
  kind,
  app,
  headerEmail,
  footer,
  stepKey,
  children,
}: JourneyPageProps) {
  return (
    <main className={`${styles.page} brand-exomem`}>
      <FlowField kind={kind} footer={!!footer} />
      <div className={styles.wordmark}>
        <Wordmark />
      </div>
      {headerEmail ? <div className={styles.headerEmail}>{headerEmail}</div> : null}
      <div className={styles.center}>
        <div className={styles.column}>
          <div className={styles.tiles}>
            <PairedTiles state={tilesState(kind)} app={app} />
          </div>
          <div className={styles.content} key={stepKey}>
            {children}
          </div>
        </div>
      </div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </main>
  );
}
