import type { CSSProperties } from "react";
import { DOT_E_INK, DOT_E_LIT, DOT_E_RADIUS } from "./dot-e";
import styles from "./PairedTiles.module.css";

// Each ink dot lights a little after the one before, in reading order; the slot the
// middle row would take (.35 s) is skipped. From the Journey board's tile mark.
const SWEEP_DELAY_S = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];

type PairedTilesProps = {
  /** idle: asking · connecting: the dot travels · connected: the Exomem tile blooms · stopped: the light is out. */
  state: "idle" | "connecting" | "connected" | "stopped";
  /** The app asking to connect. Omit when the person started on our site: only the Exomem tile shows. */
  app?: { name: string; glyph: string; glyphSize: number };
};

/** The consent page's pairing: the app's tile, a line, and the Exomem tile. */
export function PairedTiles({ state, app }: PairedTilesProps) {
  return (
    <div className={`${styles.tiles} ${state === "idle" ? "" : styles[state]}`}>
      {app && (
        <>
          <div className={styles.tile} title={app.name} style={{ fontSize: app.glyphSize }}>
            <span aria-hidden="true">{app.glyph}</span>
          </div>
          <svg className={styles.pair} height="10" aria-hidden="true">
            <line className={styles.pl} x1="4" y1="5" x2="100%" y2="5" strokeWidth="1.5" />
            <circle className={styles.pd} cx="4" cy="5" r="2.6" />
          </svg>
        </>
      )}
      <div className={`${styles.tile} ${styles.xt}`}>
        <svg viewBox="0 0 48 48" width="42" height="42" role="img" aria-label="Exomem">
          {DOT_E_INK.map(([cx, cy], i) => (
            <circle
              key={`${cx},${cy}`}
              className={styles.ed}
              cx={cx}
              cy={cy}
              r={DOT_E_RADIUS}
              style={{ "--rd": `${SWEEP_DELAY_S[i]}s` } as CSSProperties}
            />
          ))}
          {DOT_E_LIT.map(([cx, cy], i) => (
            <circle
              key={`${cx},${cy}`}
              className={styles.md}
              cx={cx}
              cy={cy}
              r={DOT_E_RADIUS}
              style={{ "--i": i } as CSSProperties}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
