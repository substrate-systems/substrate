import { ImageResponse } from "next/og";

export const runtime = "nodejs";

function FileLine({ title, meta }: { title: string; meta: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.035)",
        borderRadius: 8,
        padding: "14px 16px",
      }}
    >
      <div style={{ color: "#f5f5f5", fontSize: 18, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "#737373", fontSize: 14 }}>{meta}</div>
    </div>
  );
}

export function GET() {
  return new ImageResponse(
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
          display: "flex",
          background:
            "radial-gradient(circle at 72% 46%, rgba(255,255,255,0.075), transparent 32%), radial-gradient(circle at 16% 86%, rgba(255,255,255,0.045), transparent 26%), linear-gradient(135deg, #050505 0%, #0a0a0a 54%, #111111 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          opacity: 0.42,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
          maskImage: "linear-gradient(90deg, transparent 0%, black 55%, black 100%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          right: 76,
          top: 78,
          width: 438,
          height: 474,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(10,10,10,0.86)",
            boxShadow: "0 32px 100px rgba(0,0,0,0.62)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              color: "#737373",
              fontSize: 14,
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: 999, background: "#525252" }} />
            <span style={{ width: 9, height: 9, borderRadius: 999, background: "#737373" }} />
            <span style={{ width: 9, height: 9, borderRadius: 999, background: "#a3a3a3" }} />
            <span style={{ marginLeft: 8 }}>agent-memory</span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              padding: 22,
              fontFamily: "JetBrains Mono, Consolas, monospace",
            }}
          >
            <div style={{ color: "#a3a3a3", fontSize: 18 }}>
              $ exomem find &quot;stale plan&quot;
            </div>
            <div style={{ color: "#f5f5f5", fontSize: 19 }}>Notes/Research/q4-architecture.md</div>
            <div style={{ color: "#f5f5f5", fontSize: 19 }}>Notes/Insights/context-budget.md</div>
            <div style={{ color: "#737373", fontSize: 17 }}>
              2 reviewed results · provenance attached
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FileLine title="Sources" meta="articles, PDFs, images, transcripts" />
          <FileLine title="Compiled notes" meta="decisions, insights, failures, patterns" />
          <FileLine title="Review queue" meta="stale, nearby, unprocessed" />
        </div>
      </div>

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
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.20)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.04)",
              color: "#f5f5f5",
              fontSize: 24,
              fontWeight: 700,
            }}
          >
            E
          </div>
          <div style={{ color: "#f5f5f5", fontSize: 28, fontWeight: 650 }}>Exomem</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 126, maxWidth: 608 }}>
          <div
            style={{
              color: "#fafafa",
              fontSize: 78,
              lineHeight: 0.98,
              letterSpacing: 0,
              fontWeight: 680,
            }}
          >
            External memory for agents.
          </div>
          <div
            style={{
              marginTop: 24,
              color: "#a3a3a3",
              fontSize: 26,
              lineHeight: 1.32,
              maxWidth: 510,
              fontWeight: 400,
            }}
          >
            Durable context over owned Markdown and Obsidian vaults.
          </div>
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
