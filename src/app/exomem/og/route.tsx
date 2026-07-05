import { ImageResponse } from "next/og";

export const runtime = "nodejs";

// Social card for /exomem — the canonical preview surface. Mirrors the page's
// phosphor-amber identity: warm near-black, mono-forward, amber ONLY on the
// live/retrieved state (the 864 ms status, the "current" result, the lit dot).
// next/og renders without loaded custom fonts (Satori default); the family hints
// keep intent without a runtime font fetch.

const MONO = "IBM Plex Mono, ui-monospace, monospace";
const AMBER = "#ffb000";

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "#0a0908",
          color: "#ece9e2",
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
              "radial-gradient(circle at 74% 44%, rgba(255,176,0,0.10), transparent 34%), radial-gradient(circle at 12% 88%, rgba(255,176,0,0.04), transparent 30%), linear-gradient(135deg, #0a0908 0%, #100e0c 60%, #14120f 100%)",
          }}
        />
        {/* dot grid, faded to the right */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage:
              "radial-gradient(rgba(236,233,226,0.05) 1px, transparent 1px)",
            backgroundSize: "26px 26px",
            maskImage:
              "linear-gradient(90deg, transparent 0%, black 50%, black 100%)",
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
            border: "1px solid rgba(236,233,226,0.10)",
            background: "#100e0c",
            boxShadow:
              "0 0 0 1px rgba(0,0,0,0.4), 0 30px 90px rgba(0,0,0,0.5), 0 0 120px rgba(255,176,0,0.06)",
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
              borderBottom: "1px solid rgba(236,233,226,0.07)",
              fontFamily: MONO,
              fontSize: 17,
            }}
          >
            <div style={{ display: "flex", color: "#a39e93" }}>
              <span style={{ color: "#5c574d" }}>$&nbsp;</span>kb find
              &quot;stale decision&quot;
            </div>
            <div style={{ display: "flex", color: AMBER, fontSize: 15 }}>
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
              <span style={{ color: "#ece9e2" }}>
                → notes/newer-constraint.md
              </span>
              <span style={{ color: AMBER, fontSize: 15 }}>current</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{ color: "#6b655a", textDecoration: "line-through" }}
              >
                → notes/old-plan.md
              </span>
              <span style={{ color: "#5c574d", fontSize: 15 }}>superseded</span>
            </div>
            <div style={{ display: "flex", color: "#5c574d", fontSize: 15 }}>
              2 results · 864 ms end-to-end · 50,000 notes
            </div>
          </div>

          {/* legend */}
          <div
            style={{
              display: "flex",
              gap: 20,
              padding: "14px 20px",
              borderTop: "1px solid rgba(236,233,226,0.07)",
              fontFamily: MONO,
              fontSize: 14,
              color: "#5c574d",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  background: AMBER,
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
                  border: "1px solid #5c574d",
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
                border: "1px solid rgba(236,233,226,0.14)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#171512",
                color: "#fafafa",
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
                color: "#ece9e2",
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
                color: "#ece9e2",
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
                color: "#a39e93",
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
                color: "#5c574d",
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
