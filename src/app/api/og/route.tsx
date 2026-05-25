import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const DEFAULT_TITLE = "Substrate — Foundational Systems";
const MAX_TITLE = 180;

export function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawTitle = searchParams.get("title")?.trim();
  const title = (rawTitle && rawTitle.length > 0 ? rawTitle : DEFAULT_TITLE).slice(0, MAX_TITLE);

  // Scale title down for long headlines so it always fits the 1200×630 frame.
  const titleSize = title.length > 110 ? 52 : title.length > 70 ? 64 : 76;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#050505",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 18,
            color: "#525252",
            letterSpacing: "0.24em",
            textTransform: "uppercase",
          }}
        >
          substratesystems.io
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
              marginTop: 40,
              paddingTop: 24,
              borderTop: "1px solid rgba(255,255,255,0.12)",
              fontSize: 22,
              color: "#a3a3a3",
              fontWeight: 300,
            }}
          >
            Hugo Ander Kivi
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
