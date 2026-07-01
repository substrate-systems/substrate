import { ImageResponse } from "next/og";

export const runtime = "nodejs";

function Node({ label, x, y, tone = "neutral" }: { label: string; x: number; y: number; tone?: "neutral" | "accent" }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 150,
        height: 58,
        borderRadius: 18,
        border: tone === "accent" ? "1px solid rgba(94,234,212,0.55)" : "1px solid rgba(255,255,255,0.14)",
        background: tone === "accent" ? "rgba(20,184,166,0.16)" : "rgba(255,255,255,0.055)",
        color: tone === "accent" ? "#ccfbf1" : "#d4d4d4",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 19,
        fontWeight: 650,
      }}
    >
      {label}
    </div>
  );
}

function Line({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  return (
    <div
      style={{
        position: "absolute",
        left: x1,
        top: y1,
        width: length,
        height: 2,
        background: "linear-gradient(90deg, rgba(94,234,212,0.08), rgba(94,234,212,0.42), rgba(94,234,212,0.08))",
        transformOrigin: "left center",
        transform: `rotate(${angle}deg)`,
      }}
    />
  );
}

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
          background: "#050505",
          color: "#fafafa",
          fontFamily: "Inter, Arial, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 78% 24%, rgba(94,234,212,0.18), transparent 28%), radial-gradient(circle at 48% 76%, rgba(59,130,246,0.12), transparent 32%), linear-gradient(135deg, #050505 0%, #081211 54%, #040607 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.18,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            maskImage: "radial-gradient(circle at 68% 48%, black, transparent 72%)",
          }}
        />

        <div style={{ position: "absolute", right: 72, top: 78, width: 470, height: 470 }}>
          <Line x1={132} y1={120} x2={250} y2={200} />
          <Line x1={132} y1={318} x2={250} y2={228} />
          <Line x1={280} y1={116} x2={250} y2={200} />
          <Line x1={292} y1={320} x2={250} y2={228} />
          <Line x1={252} y1={229} x2={330} y2={218} />
          <Node label="Sources" x={20} y={88} />
          <Node label="Evidence" x={20} y={286} />
          <Node label="Notes" x={262} y={84} />
          <Node label="Review" x={276} y={288} />
          <Node label="Exomem" x={176} y={184} tone="accent" />
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
                width: 36,
                height: 36,
                borderRadius: 12,
                border: "1px solid rgba(94,234,212,0.55)",
                background: "rgba(94,234,212,0.12)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#99f6e4",
                fontSize: 22,
                fontWeight: 800,
              }}
            >
              E
            </div>
            <div style={{ fontSize: 24, color: "#ccfbf1", fontWeight: 700 }}>Exomem</div>
          </div>

          <div style={{ maxWidth: 650, display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontSize: 88,
                lineHeight: 0.92,
                letterSpacing: "-0.06em",
                fontWeight: 760,
              }}
            >
              External memory for agents.
            </div>
            <div style={{ marginTop: 28, maxWidth: 590, color: "#b8c8c5", fontSize: 29, lineHeight: 1.3 }}>
              MCP-native context over your own Markdown and Obsidian vault.
            </div>
          </div>

          <div style={{ display: "flex", gap: 20, color: "#99f6e4", fontSize: 21, fontWeight: 650 }}>
            <span>hybrid retrieval</span>
            <span style={{ color: "#31534e" }}>·</span>
            <span>multimodal indexing</span>
            <span style={{ color: "#31534e" }}>·</span>
            <span>review queues</span>
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