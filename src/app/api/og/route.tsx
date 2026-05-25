import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

// metal-structure-dark is the existing hero-image texture (Adrien Olichon / Pexels,
// attributed in src/app/layout.tsx). Embedded once at module load — Satori needs
// base64/binary, not a URL.
const TEXTURE_DATA_URI = `data:image/jpeg;base64,${readFileSync(
  path.join(process.cwd(), "public/brand/materials/metal-structure-dark.jpg"),
).toString("base64")}`;

const DEFAULT_TITLE = "Substrate — Foundational Systems";
const MAX_TITLE = 180;
const TEXTURE_OPACITY = 0.5;

export function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawTitle = searchParams.get("title")?.trim();
  const title = (rawTitle && rawTitle.length > 0 ? rawTitle : DEFAULT_TITLE).slice(0, MAX_TITLE);
  const titleSize = title.length > 110 ? 52 : title.length > 70 ? 64 : 76;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#050505",
          display: "flex",
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        <img
          src={TEXTURE_DATA_URI}
          width={1200}
          height={630}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            objectFit: "cover",
            opacity: TEXTURE_OPACITY,
          }}
        />

        {/* Vignette: darkens edges so corner content stays legible regardless of texture brightness */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            background:
              "linear-gradient(180deg, rgba(5,5,5,0.55) 0%, rgba(5,5,5,0.35) 45%, rgba(5,5,5,0.80) 100%)",
          }}
        />

        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "72px 80px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 500,
              color: "#fafafa",
              letterSpacing: "0.3em",
            }}
          >
            SUBSTRATE
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: titleSize,
                color: "#fafafa",
                lineHeight: 1.1,
                letterSpacing: "-0.02em",
                fontWeight: 300,
              }}
            >
              {title}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                marginTop: 40,
                paddingTop: 24,
                borderTop: "1px solid rgba(255,255,255,0.18)",
                fontSize: 22,
                fontWeight: 300,
              }}
            >
              <div style={{ display: "flex", color: "#a3a3a3" }}>Hugo Ander Kivi</div>
              <div style={{ display: "flex", color: "#525252", padding: "0 14px" }}>·</div>
              <div style={{ display: "flex", color: "#a3a3a3" }}>substratesystems.io</div>
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
