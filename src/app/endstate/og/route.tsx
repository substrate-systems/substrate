import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";

const SCREENSHOT_DATA_URI = `data:image/png;base64,${readFileSync(
  path.join(process.cwd(), "public/endstate/01-landing.png"),
).toString("base64")}`;

const MARK_DATA_URI = `data:image/svg+xml;base64,${readFileSync(
  path.join(process.cwd(), "public/endstate/icons/transparent/transparent-sw5.svg"),
).toString("base64")}`;

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
          background: "#07110f",
          color: "#f8fafc",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            display: "flex",
            background:
              "radial-gradient(circle at 76% 30%, rgba(45,212,191,0.18), transparent 34%), linear-gradient(135deg, #07110f 0%, #0b1514 52%, #050807 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 58,
            bottom: -42,
            width: 610,
            height: 450,
            display: "flex",
            overflow: "hidden",
            borderRadius: 28,
            border: "1px solid rgba(148,163,184,0.22)",
            boxShadow: "0 34px 90px rgba(0,0,0,0.5)",
            background: "#0b0f12",
          }}
        >
          <img
            src={SCREENSHOT_DATA_URI}
            width={610}
            height={450}
            style={{ width: 610, height: 450, objectFit: "cover", objectPosition: "top left" }}
          />
        </div>
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "100%",
            height: "100%",
            padding: "66px 76px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <img src={MARK_DATA_URI} width={48} height={48} />
            <div style={{ display: "flex", fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em" }}>
              Endstate
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 660 }}>
            <div
              style={{
                display: "flex",
                fontSize: 76,
                lineHeight: 0.98,
                fontWeight: 700,
                letterSpacing: "-0.05em",
              }}
            >
              Set up your new Windows PC in minutes.
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 26,
                fontSize: 29,
                lineHeight: 1.28,
                color: "#b6c8c5",
                maxWidth: 610,
              }}
            >
              Capture apps and settings, then restore them on a fresh install.
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              color: "#6ee7d8",
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            <span>Free local product</span>
            <span style={{ color: "#3d6660" }}>·</span>
            <span>Open source engine</span>
            <span style={{ color: "#3d6660" }}>·</span>
            <span>No account required</span>
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