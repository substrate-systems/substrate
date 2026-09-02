import { c } from "../_palette";
import { EndstateFooter, Nav } from "../_shared";
import { SupportTiers } from "./SupportTiers";

// Single source of truth: SUPPORTERS.md in the open-source engine repo. This page
// renders the same list, so names live in one place and show in both (repo + site).
const SUPPORTERS_MD_URL = "https://raw.githubusercontent.com/Artexis10/endstate/main/SUPPORTERS.md";

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

        <section className="pt-32 sm:pt-40 pb-14 sm:pb-20 px-6">
          <div
            className="mx-auto grid gap-8 lg:grid-cols-[1.3fr_0.7fr] lg:items-end"
            style={{ maxWidth: 1100 }}
          >
            <div style={{ maxWidth: 720 }}>
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: c.copper,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: "1.5rem",
                }}
              >
                Support Endstate
              </p>
              <h1
                style={{
                  fontSize: "clamp(2.4rem, 5.5vw, 4.4rem)",
                  fontWeight: 700,
                  lineHeight: 1.05,
                  letterSpacing: "-0.05em",
                  color: c.text,
                  marginBottom: "1.5rem",
                }}
              >
                The people who fund Endstate
              </h1>
              <p
                style={{
                  fontSize: "1.125rem",
                  lineHeight: 1.7,
                  color: c.textSec,
                  marginBottom: "2rem",
                  maxWidth: 640,
                }}
              >
                Endstate is free for everyone because of the people below. They chose to support the
                project — no extra features, no private access, just support — so the rest of it can
                stay free, open, and without telemetry. Thank you.
              </p>
              <a
                href="#support"
                data-support-primary-cta
                className="inline-block py-3 px-6 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                style={{
                  background: c.teal,
                  color: c.bg,
                  fontSize: "0.95rem",
                  textDecoration: "none",
                  boxShadow: "0 8px 24px rgba(45,212,191,0.24)",
                }}
              >
                Support Endstate
              </a>
            </div>

            <aside
              className="rounded-2xl p-6 sm:p-7"
              style={{ background: c.elevated, border: `1px solid ${c.border}` }}
            >
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  color: c.teal,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  marginBottom: "1rem",
                }}
              >
                Free by design
              </p>
              <p
                style={{
                  fontSize: "1.1rem",
                  lineHeight: 1.5,
                  color: c.text,
                  marginBottom: "0.75rem",
                }}
              >
                Supporting is voluntary. The free product is the whole product.
              </p>
              <p style={{ fontSize: "0.9rem", lineHeight: 1.65, color: c.textSec, margin: 0 }}>
                It is not a licence, a plan, or an upgrade — and it unlocks nothing that is not
                already there.
              </p>
            </aside>
          </div>
        </section>

        <section className="py-20 sm:py-24 px-6" style={{ borderTop: `1px solid ${c.border}` }}>
          <div className="mx-auto" style={{ maxWidth: 1100 }}>
            <div
              className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
              style={{ marginBottom: "2rem" }}
            >
              <div style={{ maxWidth: 640 }}>
                <p
                  style={{
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: "0.75rem",
                    fontWeight: 500,
                    color: c.textSec,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    marginBottom: "0.75rem",
                  }}
                >
                  Recognition
                </p>
                <h2
                  style={{
                    fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)",
                    fontWeight: 700,
                    letterSpacing: "-0.035em",
                    color: c.text,
                    margin: 0,
                  }}
                >
                  A public thank-you, by consent
                </h2>
              </div>
              <p style={{ fontSize: "0.85rem", color: c.textSec, margin: 0, lineHeight: 1.6 }}>
                Names only. No tiers, amounts, or transaction details.
              </p>
            </div>

            <div
              data-supporter-roster
              className="rounded-2xl p-6 sm:p-8"
              style={{
                background: c.card,
                border: `1px solid ${c.border}`,
                boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
              }}
            >
              {supporters.length > 0 ? (
                <ul
                  className="grid gap-x-10 sm:grid-cols-2"
                  style={{ listStyle: "none", padding: 0, margin: 0 }}
                >
                  {supporters.map((name, i) => (
                    <li
                      key={`${name}-${i}`}
                      className="flex items-center gap-3"
                      style={{
                        fontSize: "1rem",
                        color: c.text,
                        borderBottom: `1px solid ${c.border}`,
                        padding: "0.9rem 0",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{ color: c.teal, fontWeight: 700, fontSize: "0.8rem" }}
                      >
                        ◆
                      </span>
                      {name}
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ padding: "1.25rem", textAlign: "center" }}>
                  <p style={{ fontSize: "1rem", color: c.textSec, marginBottom: "1.25rem" }}>
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
            </div>

            <p
              style={{
                fontSize: "0.85rem",
                color: c.textSec,
                marginTop: "1.25rem",
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
          className="py-20 sm:py-24 px-6"
          style={{ borderTop: `1px solid ${c.border}` }}
        >
          <div
            className="mx-auto grid gap-10 lg:grid-cols-[0.75fr_1.25fr]"
            style={{ maxWidth: 1100 }}
          >
            <div>
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: c.copper,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: "1rem",
                }}
              >
                Support Endstate
              </p>
              <h2
                style={{
                  fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)",
                  fontWeight: 700,
                  letterSpacing: "-0.035em",
                  color: c.text,
                  marginBottom: "1.25rem",
                }}
              >
                Contribute to the project
              </h2>
              <p style={{ fontSize: "1rem", lineHeight: 1.7, color: c.textSec, margin: 0 }}>
                Supporting Endstate is voluntary and separate from anything you buy. It is not a
                licence, a plan, or an upgrade: it unlocks no features, carries no recurring
                obligation, and nothing in the product checks whether you have contributed. The free
                product is already the whole product. If Endstate saved you a rebuild and you want
                it to keep going, this is the way to say so.
              </p>
            </div>
            <SupportTiers />
          </div>
        </section>

        <section className="pb-20 sm:pb-24 px-6">
          <div
            className="mx-auto rounded-2xl p-6 sm:p-8"
            style={{ maxWidth: 1100, background: c.elevated, border: `1px solid ${c.border}` }}
          >
            <p style={{ fontSize: "0.9rem", color: c.textSec, margin: 0, lineHeight: 1.65 }}>
              Recognition is opt-in and stays that way — the GitHub Sponsors thank-you asks whether
              you would like to be listed, and nothing is published unless you say yes. A listing is
              an acknowledgement, not advertising and not something a contribution buys. Looking to
              fund a specific integration instead?{" "}
              <a
                href="/endstate/sponsor-an-integration"
                style={{
                  color: c.teal,
                  textDecoration: "underline",
                  textDecorationColor: "rgba(45,212,191,0.35)",
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
