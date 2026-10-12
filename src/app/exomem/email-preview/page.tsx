import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import { EmailFrame } from "./email-frame";
import { exomemEmailSamples } from "./samples";
import styles from "./email-preview.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Exomem emails",
  robots: { index: false, follow: false },
};

/**
 * Every Exomem email as it is sent, rendered now with sample input, in the dark and the
 * light scheme side by side, for QA to compare with the R28 and R12 boards. Not linked
 * from anywhere, and never served in production.
 */
export default function EmailPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  const samples = exomemEmailSamples(new Date(), exomemPublicBaseUrlFromEnv());
  return (
    <main className={styles.page}>
      <header className={styles.intro}>
        <div className={styles.eyebrow}>Dev only · rendered {new Date().toISOString()}</div>
        <h1 className={styles.title}>Exomem emails</h1>
      </header>
      {samples.map((sample) => (
        <section key={sample.id} className={styles.sample} aria-labelledby={`email-${sample.id}`}>
          <div className={styles.head}>
            <span className={styles.number}>{sample.number}</span>
            <h2 id={`email-${sample.id}`} className={styles.subject}>
              {sample.email.subject}
            </h2>
            <span className={styles.meta}>
              {sample.note} · from {sample.email.senderName} · {sample.email.subject.length} characters
            </span>
          </div>
          <div className={styles.frames}>
            <EmailFrame html={sample.email.htmlContent} scheme="dark" title={`${sample.number} dark`} />
            <EmailFrame html={sample.email.htmlContent} scheme="light" title={`${sample.number} light`} />
          </div>
          <details className={styles.text}>
            <summary>Plain-text part</summary>
            <pre>{sample.email.textContent}</pre>
          </details>
        </section>
      ))}
    </main>
  );
}
