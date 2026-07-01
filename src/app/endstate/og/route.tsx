import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const runtime = "nodejs";

function assetDataUrl(path: string, mime: string) {
  const data = readFileSync(join(process.cwd(), "public", path));
  return `data:${mime};base64,${data.toString("base64")}`;
}

export function GET() {
  const mark = assetDataUrl("endstate/icons/transparent/transparent-sw5.svg", "image/svg+xml");
  const screenshot = assetDataUrl("endstate/01-landing.png", "image/png");

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        overflow: "hidden",
        background: "#0c0c0c",
        color: "#e8e8e8",
        fontFamily: "DM Sans, Inter, Arial, sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          background:
            "radial-gradient(circle at 78% 44%, rgba(45,212,191,0.10), transparent 28%), radial-gradient(circle at 16% 80%, rgba(34,197,94,0.08), transparent 30%), linear-gradient(#0c0c0c, #0c0c0c)",
        }}
      />

      <div
        style={{
          position: "absolute",
          right: 48,
          top: 126,
          width: 486,
          height: 364,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 12,
          border: "1px solid #2a2a2a",
          background: "#111111",
          boxShadow: "0 32px 110px rgba(0,0,0,0.58)",
        }}
      >
        <div
          style={{
            height: 40,
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            borderBottom: "1px solid #242424",
            color: "#666666",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Endstate app
        </div>
        <img
          src={screenshot}
          width={486}
          height={324}
          style={{
            width: 486,
            height: 324,
            objectFit: "cover",
            objectPosition: "50% 44%",
          }}
        />
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "72px 76px 54px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <img src={mark} width={48} height={48} style={{ width: 48, height: 48 }} />
          <div style={{ color: "#e8e8e8", fontSize: 31, fontWeight: 700 }}>Endstate</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 84, maxWidth: 520 }}>
          <div
            style={{
              fontSize: 58,
              lineHeight: 1.04,
              letterSpacing: 0,
              fontWeight: 700,
              color: "#e8e8e8",
            }}
          >
            Don&apos;t set up your next machine from memory.
          </div>
          <div
            style={{
              marginTop: 24,
              maxWidth: 520,
              color: "#999999",
              fontSize: 25,
              lineHeight: 1.36,
              fontWeight: 400,
            }}
          >
            Capture apps and settings, then restore them on a fresh install.
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 76,
            bottom: 54,
            display: "flex",
            gap: 18,
            color: "#2dd4bf",
            fontSize: 18,
            fontWeight: 600,
          }}
        >
          <span>free local product</span>
          <span style={{ color: "#3a3a3a" }}>·</span>
          <span>open source engine</span>
          <span style={{ color: "#3a3a3a" }}>·</span>
          <span>no account required</span>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    }
  );
}
