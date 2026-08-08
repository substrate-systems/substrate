import { c, Nav, EndstateFooter } from "../_shared";
import { SupportTiers } from "./SupportTiers";

// Single source of truth: SUPPORTERS.md in the open-source engine repo. This page
// renders the same list, so names live in one place and show in both (repo + site).
const SUPPORTERS_MD_URL =
  "https://raw.githubusercontent.com/Artexis10/endstate/main/SUPPORTERS.md";

// Extract the "## Supporters" section's list items (one supporter per `- ` line).
function parseSupporters(md: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Supporters\s*$/i.test(l.trim()));
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line) || line === "---") break; // next section / rule
    const m = line.match(/^[-*]\s+(.+)$/);
    if (m && m[1].trim()) names.push(m[1].trim());
  }
  return names;
}

async function getSupporters(): Promise<string[]> {
  try {
    const res = await fetch(SUPPORTERS_MD_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    return parseSupporters(await res.text());
  } catch {
    return [];
  }
}

export default async function SupportersPage() {
  const supporters = await getSupporters();

  return (
    <>
      <main
        style={{
          fontFamily: "var(--font-dm-sans), -apple-system, sans-serif",
          background: c.bg,
          minHeight: "100vh",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <Nav />

        <section className="pt-32 sm:pt-40 pb-24 px-6">
          <div className="mx-auto" style={{ maxWidth: 680 }}>
            <p
              style={{
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: "0.75rem",
                fontWeight: 500,
                color: c.textMuted,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: "1.5rem",
              }}
            >
              Supporters
            </p>

            <h1
              style={{
                fontSize: "clamp(2rem, 4.5vw, 2.8rem)",
                fontWeight: 700,
                lineHeight: 1.15,
                letterSpacing: "-0.03em",
                color: c.text,
                marginBottom: "1.5rem",
              }}
            >
              The people who fund Endstate
            </h1>

            <p
              style={{
                fontSize: "1.05rem",
                lineHeight: 1.7,
                color: c.textSec,
                marginBottom: "3rem",
              }}
            >
              Endstate is free for everyone because of the people below. They
              chose to support the project — no extra features, no private
              access, just support — so the rest of it can stay free, open, and
              without telemetry. Thank you.
            </p>

            {supporters.length > 0 ? (
              <ul className="space-y-3" style={{ listStyle: "none", padding: 0 }}>
                {supporters.map((name, i) => (
                  <li
                    key={`${name}-${i}`}
                    className="flex items-center gap-3"
                    style={{
                      fontSize: "1rem",
                      color: c.text,
                      borderBottom: `1px solid ${c.border}`,
                      paddingBottom: "0.75rem",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{ color: c.green, fontWeight: 700, fontSize: "0.8rem" }}
                    >
                      ◆
                    </span>
                    {name}
                  </li>
                ))}
              </ul>
            ) : (
              <div
                style={{
                  border: `1px solid ${c.border}`,
                  borderRadius: 12,
                  padding: "2rem",
                  textAlign: "center",
                }}
              >
                <p
                  style={{
                    fontSize: "1rem",
                    color: c.textSec,
                    marginBottom: "1.25rem",
                  }}
                >
                  No supporters listed yet. Want to be the first?
                </p>
                <a
                  href="#support"
                  className="inline-block py-2.5 px-5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                  style={{
                    background: c.text,
                    color: c.bg,
                    fontSize: "0.95rem",
                    textDecoration: "none",
                  }}
                >
                  Support Endstate
                </a>
              </div>
            )}

            <p
              style={{
                fontSize: "0.85rem",
                color: c.textMuted,
                marginTop: "2.5rem",
                lineHeight: 1.6,
              }}
            >
              Listing is opt-in. The same list lives in{" "}
              <a
                href="https://github.com/Artexis10/endstate/blob/main/SUPPORTERS.md"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: c.textSec,
                  textDecoration: "underline",
                  textDecorationColor: "rgba(153,153,153,0.3)",
                }}
              >
                SUPPORTERS.md
              </a>{" "}
              in the open-source repo.
            </p>
          </div>
        </section>

        <section
          id="support"
          className="py-24 px-6"
          style={{ borderTop: `1px solid ${c.border}` }}
        >
          <div className="mx-auto" style={{ maxWidth: 680 }}>
            <p
              style={{
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: "0.75rem",
                fontWeight: 500,
                color: c.textMuted,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: "1.5rem",
              }}
            >
              Support Endstate
            </p>

            <h2
              style={{
                fontSize: "clamp(1.6rem, 3.5vw, 2.1rem)",
                fontWeight: 700,
                letterSpacing: "-0.03em",
                color: c.text,
                marginBottom: "1.25rem",
              }}
            >
              Contribute to the project
            </h2>

            <p
              style={{
                fontSize: "1rem",
                lineHeight: 1.7,
                color: c.textSec,
                marginBottom: "2.5rem",
              }}
            >
              Supporting Endstate is voluntary and separate from anything you
              buy. It is not a licence, a plan, or an upgrade: it unlocks no
              features, carries no recurring obligation, and nothing in the
              product checks whether you have contributed. The free product is
              already the whole product. If Endstate saved you a rebuild and you
              want it to keep going, this is the way to say so.
            </p>

            <SupportTiers />

            <p
              style={{
                fontSize: "0.85rem",
                color: c.textMuted,
                marginTop: "2rem",
                lineHeight: 1.6,
              }}
            >
              Recognition is opt-in and stays that way — after a contribution you
              are asked whether you would like to be listed, and nothing is
              published unless you say yes. Looking to fund a specific
              integration instead?{" "}
              <a
                href="/endstate/sponsor-an-integration"
                style={{
                  color: c.textSec,
                  textDecoration: "underline",
                  textDecorationColor: "rgba(153,153,153,0.3)",
                }}
              >
                Sponsor an integration
              </a>
              .
            </p>
          </div>
        </section>

        <EndstateFooter />
      </main>
    </>
  );
}
