import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import Footer from "@/components/Footer";
import { getPostBySlug, getPostSlugs } from "@/lib/blog";
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
  const post = await getPostBySlug(slug);
  if (!post) return {};

  const { title, description, published, author } = post.frontmatter;
  return {
    title,
    description,
    authors: author ? [{ name: author }] : undefined,
    openGraph: {
      title,
      description,
      type: "article",
      publishedTime: published,
      url: `/blog/${slug}`,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
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

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const { title, published, author } = post.frontmatter;

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

      <article className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="text-display-sm font-light tracking-tight text-fg-primary sm:text-display">
          {title}
        </h1>
        <p className="mt-4 text-body-sm text-fg-tertiary">
          {formatDate(published)}
          {author ? ` · ${author}` : ""}
        </p>

        <div className="mt-10 border-t border-border-subtle pt-10">
          <div className={styles.prose}>{post.content}</div>
        </div>
      </article>

      <Footer />
    </div>
  );
}
