import { ImageResponse } from "next/og";

export const runtime = "nodejs";

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
          background: "#06110f",
          color: "#f8fafc",
          fontFamily: "Inter, Arial, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 78% 28%, rgba(45,212,191,0.22), transparent 30%), radial-gradient(circle at 18% 78%, rgba(34,197,94,0.13), transparent 28%), linear-gradient(135deg, #07110f 0%, #081614 48%, #030706 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 72,
            top: 86,
            width: 390,
            height: 430,
            display: "flex",
            flexDirection: "column",
            border: "1px solid rgba(110,231,216,0.22)",
            borderRadius: 30,
            background: "rgba(3,7,6,0.78)",
            boxShadow: "0 40px 110px rgba(0,0,0,0.55)",
            padding: 30,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                border: "1px solid rgba(110,231,216,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#6ee7d8",
                fontSize: 24,
              }}
            >
              ✓
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 24, fontWeight: 700 }}>Endstate</div>
              <div style={{ marginTop: 4, color: "#8fb9b3", fontSize: 15 }}>
                machine state, captured
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 44 }}>
            {[
              ["scan", "installed apps + settings"],
              ["save", "portable local manifest"],
              ["restore", "fresh machine, same setup"],
            ].map(([label, text]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 18,
                  borderTop: "1px solid rgba(110,231,216,0.14)",
                  paddingTop: 15,
                }}
              >
                <span style={{ color: "#6ee7d8", fontSize: 17, fontWeight: 700 }}>
                  {label}
                </span>
                <span style={{ color: "#b6c8c5", fontSize: 17, textAlign: "right" }}>
                  {text}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "72px 76px 58px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                border: "2px solid #6ee7d8",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ width: 12, height: 12, borderRadius: 999, background: "#6ee7d8" }} />
            </div>
            <div style={{ fontSize: 24, color: "#e6fffb", fontWeight: 700 }}>Endstate</div>
          </div>

          <div style={{ maxWidth: 690, display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontSize: 76,
                lineHeight: 0.98,
                letterSpacing: "-0.055em",
                fontWeight: 760,
              }}
            >
              Machine setup without rebuilding from memory.
            </div>
            <div style={{ marginTop: 28, maxWidth: 590, color: "#b6c8c5", fontSize: 28, lineHeight: 1.32 }}>
              Windows-first provisioning and backup, with the cross-platform engine moving through Linux and macOS validation.
            </div>
          </div>

          <div style={{ display: "flex", gap: 20, color: "#6ee7d8", fontSize: 21, fontWeight: 650 }}>
            <span>local-first</span>
            <span style={{ color: "#31534e" }}>·</span>
            <span>open source engine</span>
            <span style={{ color: "#31534e" }}>·</span>
            <span>server cannot decrypt backups</span>
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