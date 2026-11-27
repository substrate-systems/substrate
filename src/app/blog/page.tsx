import Link from "next/link";
import Footer from "@/components/Footer";
import SiteHeader from "@/components/SiteHeader";
import { getPublishedPostsMeta } from "@/lib/blog";
import { buildMetadata } from "@/lib/seo";

// The blog layout's template applies only to child segments (blog/[slug]), not to this
// same-segment page — so the "· Substrate" suffix here comes from the root template.
export const metadata = buildMetadata({
  title: "Writing on infrastructure & LLM governance",
  description:
    "Field notes from Substrate on durable infrastructure, LLM governance, contracts for AI-augmented codebases, and building foundational systems solo.",
  path: "/blog",
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function BlogIndexPage() {
  const posts = getPublishedPostsMeta().sort((a, b) => b.published.localeCompare(a.published));

  return (
    <div className="min-h-screen bg-bg-base">
      <SiteHeader />

      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">Writing</h1>

        <ul className="mt-10 space-y-12">
          {posts.map((post) => (
            <li key={post.slug}>
              <Link href={`/blog/${post.slug}`} className="group block">
                <h2 className="text-xl font-light tracking-tight text-fg-primary transition-colors duration-default group-hover:text-white sm:text-2xl">
                  {post.title}
                </h2>
                {post.description ? (
                  <p className="mt-2 max-w-2xl text-body font-light text-fg-secondary">
                    {post.description}
                  </p>
                ) : null}
                <p className="mt-2 text-body-sm text-fg-tertiary">{formatDate(post.published)}</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>

      <Footer />
    </div>
  );
}
