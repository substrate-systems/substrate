import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import Footer from "@/components/Footer";
import { getBlogRedirect, getPostBySlug, getPostSlugs, isDraft } from "@/lib/blog";
import { breadcrumbJsonLd, buildMetadata, siteConfig } from "@/lib/seo";
import { articleJsonLd, howToJsonLd } from "@/lib/structured-data";
import styles from "./article.module.css";

export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const redirectTo = getBlogRedirect(slug);
  if (redirectTo) permanentRedirect(redirectTo);
  const post = await getPostBySlug(slug);
  if (!post) return {};

  const { title, description, published, updated, author } = post.frontmatter;
  return buildMetadata({
    title,
    description,
    path: `/blog/${slug}`,
    ogImage: `/api/og?title=${encodeURIComponent(title)}`,
    ogType: "article",
    publishedTime: published,
    modifiedTime: updated,
    authors: author ? [author] : undefined,
    noIndex: isDraft(post.frontmatter),
  });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const redirectTo = getBlogRedirect(slug);
  if (redirectTo) permanentRedirect(redirectTo);
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const { title, published, updated, author } = post.frontmatter;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Writing", path: "/blog" },
    { name: title, path: `/blog/${slug}` },
  ]);
  const article = articleJsonLd({
    title,
    description: post.frontmatter.description,
    slug,
    published,
    updated,
    // schema.org Article requires an image, and a validator counts its absence as an
    // invalid item rather than a missing nicety. Same generated card the OG tags use,
    // absolute because JSON-LD is consumed away from the page it was served on.
    image: `${siteConfig.url}/api/og?title=${encodeURIComponent(title)}`,
  });
  const howto = howToJsonLd(slug);

  return (
    <div className="min-h-screen bg-bg-base">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(article) }}
      />
      {howto ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(howto) }}
        />
      ) : null}
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

      <article className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-sm font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
        >
          <span aria-hidden="true">←</span> Writing
        </Link>
        <h1 className="mt-8 text-display-sm font-light tracking-tight text-fg-primary sm:text-display">
          {title}
        </h1>
        <p className="mt-4 text-body-sm text-fg-tertiary">
          {formatDate(published)}
          {author ? (
            <>
              {" · "}
              <Link
                href="/work"
                className="transition-colors duration-default hover:text-fg-secondary"
              >
                {author}
              </Link>
            </>
          ) : null}
        </p>

        <div className="mt-10 border-t border-border-subtle pt-10">
          <div className={styles.prose}>{post.content}</div>
        </div>
      </article>

      <Footer />
    </div>
  );
}
