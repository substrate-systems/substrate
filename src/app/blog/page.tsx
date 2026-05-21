import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import Footer from "@/components/Footer";
import { getAllPostsMeta } from "@/lib/blog";

// Title intentionally omitted: the blog layout's title.default ("Writing · Substrate")
// applies to this segment. A title here would not receive the layout's template
// (templates apply to child segments only), so it would render bare "Writing".
export const metadata: Metadata = {
  description: "Writing by Hugo Ander Kivi on AI-augmented development, governance, and systems.",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function BlogIndexPage() {
  const posts = getAllPostsMeta().sort((a, b) => b.published.localeCompare(a.published));

  return (
    <div className="min-h-screen bg-bg-base">
      <header className="mx-auto w-full max-w-3xl px-6 pt-10 sm:pt-14">
        <Link
          href="/"
          aria-label="Substrate home"
          className="inline-block opacity-40 transition-opacity duration-default hover:opacity-70"
        >
          <span className="relative block h-4 w-[160px]">
            <Image
              src="/brand/logos/substrate-logo-white-transparent.png"
              alt="Substrate"
              fill
              sizes="160px"
              className="object-contain"
            />
          </span>
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        <span className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">Writing</span>

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
