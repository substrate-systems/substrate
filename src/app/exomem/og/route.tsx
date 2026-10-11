import { ImageResponse } from "next/og";
import { exomemTokens } from "@/lib/exomem/design-tokens";

export const runtime = "nodejs";

// Social card for /exomem — the canonical preview surface. Mirrors the page's
// phosphor-amber identity: warm near-black, mono-forward, amber ONLY on the
// live/retrieved state (the 864 ms status, the "current" result, the lit dot).
// next/og renders without loaded custom fonts (Satori default); the family hints
// keep intent without a runtime font fetch.

const MONO = "IBM Plex Mono, ui-monospace, monospace";

export function GET() {
  // Satori cannot read CSS variables: the literal dark-theme token values.
  const t = exomemTokens().dark;
  const amber = t["--exo-amber"];
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: t["--bg-base"],
          color: t["--fg-primary"],
          fontFamily: "Inter, Arial, sans-serif",
        }}
      >
        {/* warm base + amber bloom behind the panel */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              `radial-gradient(circle at 74% 44%, rgba(${t["--amber-rgb"]}, 0.1), transparent 34%), radial-gradient(circle at 12% 88%, rgba(${t["--amber-rgb"]}, 0.04), transparent 30%), linear-gradient(135deg, ${t["--bg-base"]} 0%, ${t["--bg-panel"]} 60%, ${t["--bg-elevated"]} 100%)`,
          }}
        />
        {/* dot grid, faded to the right */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage: `radial-gradient(rgba(${t["--ink-rgb"]}, 0.05) 1px, transparent 1px)`,
            backgroundSize: "26px 26px",
            // A mask reads only alpha: any opaque token shows the grid.
            maskImage: `linear-gradient(90deg, transparent 0%, ${t["--bg-base"]} 50%, ${t["--bg-base"]} 100%)`,
          }}
        />

        {/* the lit memory panel */}
        <div
          style={{
            position: "absolute",
            right: 68,
            top: 96,
            width: 470,
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            border: `1px solid ${t["--exo-border-card"]}`,
            background: t["--bg-panel"],
            boxShadow: `0 0 0 1px ${t["--shadow-color"]}, 0 30px 90px ${t["--shadow-color"]}, 0 0 120px rgba(${t["--amber-rgb"]}, 0.06)`,
            overflow: "hidden",
          }}
        >
          {/* header: query + amber status */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderBottom: `1px solid ${t["--exo-rule"]}`,
              fontFamily: MONO,
              fontSize: 17,
            }}
          >
            <div style={{ display: "flex", color: t["--fg-secondary"] }}>
              <span style={{ color: t["--fg-tertiary"] }}>$&nbsp;</span>kb find
              &quot;stale decision&quot;
            </div>
            <div style={{ display: "flex", color: amber, fontSize: 15 }}>
              864 ms
            </div>
          </div>

          {/* results */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              padding: "22px 20px",
              fontFamily: MONO,
              fontSize: 17,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ color: t["--fg-primary"] }}>→ notes/newer-constraint.md</span>
              <span style={{ color: amber, fontSize: 15 }}>current</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ color: t["--fg-dim-struck"], textDecoration: "line-through" }}>
                → notes/old-plan.md
              </span>
              <span style={{ color: t["--fg-tertiary"], fontSize: 15 }}>superseded</span>
            </div>
            <div style={{ display: "flex", color: t["--fg-tertiary"], fontSize: 15 }}>
              2 results · 864 ms end-to-end · 50,000 notes
            </div>
          </div>

          {/* legend */}
          <div
            style={{
              display: "flex",
              gap: 20,
              padding: "14px 20px",
              borderTop: `1px solid ${t["--exo-rule"]}`,
              fontFamily: MONO,
              fontSize: 14,
              color: t["--fg-tertiary"],
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  background: amber,
                }}
              />
              retrieved
            </div>
            <div
              style={{ display: "flex", textDecoration: "line-through" }}
            >
              superseded
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  border: `1px solid ${t["--fg-tertiary"]}`,
                }}
              />
              note
            </div>
          </div>
        </div>

        {/* left: wordmark + headline */}
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: "72px 76px 56px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 11,
                border: `1px solid ${t["--exo-border-input"]}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: t["--bg-hover"],
                color: t["--fg-primary"],
                fontFamily: MONO,
                fontSize: 23,
                fontWeight: 600,
              }}
            >
              E
            </div>
            <div
              style={{
                display: "flex",
                color: t["--fg-primary"],
                fontFamily: MONO,
                fontSize: 27,
                fontWeight: 600,
              }}
            >
              exomem
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 132,
              maxWidth: 560,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                color: t["--fg-primary"],
                fontFamily: MONO,
                fontSize: 66,
                lineHeight: 1.12,
                letterSpacing: -2,
                fontWeight: 600,
              }}
            >
              <div style={{ display: "flex" }}>Agents get memory.</div>
              <div style={{ display: "flex" }}>You keep the files.</div>
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 28,
                color: t["--fg-secondary"],
                fontSize: 25,
                lineHeight: 1.35,
                maxWidth: 500,
                fontWeight: 400,
              }}
            >
              MCP-native memory over the Markdown &amp; Obsidian vault you own.
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 26,
                color: t["--fg-tertiary"],
                fontFamily: MONO,
                fontSize: 17,
              }}
            >
              Python · AGPL-3.0 · self-hosted · no account
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    },
  );
}
