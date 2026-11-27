import Link from "next/link";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import phone from "@/components/exomem/phone.module.css";
import home from "../home/home.module.css";
import styles from "./operator.module.css";

const PAGES = [
  { key: "invitations", label: "Invitations", href: "/exomem/operator" },
  { key: "whats-new", label: "What's new", href: "/exomem/operator/whats-new" },
] as const;

/** Home's header: the operator pages beside the wordmark, the open one marked, and Lock where Home has Sign out. */
export function OperatorHeader({
  current,
  onLock,
}: {
  current: (typeof PAGES)[number]["key"];
  onLock?: () => void;
}) {
  return (
    <header className={`${home.header} ${styles.header}`}>
      <span className={`${home.headerStart} ${styles.headerStart}`}>
        <span className={home.wordmark}>
          <Wordmark />
        </span>
        <nav className={home.nav} aria-label="Private operator">
          {PAGES.map((page) =>
            page.key === current ? (
              <span
                className={`${home.navCurrent} ${styles.navItem}`}
                key={page.key}
                aria-current="page"
              >
                {page.label}
              </span>
            ) : (
              <Link
                className={`${styles.navItem} ${styles.navLink}`}
                href={page.href}
                key={page.key}
              >
                {page.label}
              </Link>
            )
          )}
        </nav>
      </span>
      <span className={`${home.headerEnd} ${styles.headerEnd}`}>
        <ThemeToggle />
        {onLock ? (
          <button
            type="button"
            className={`${home.inlineButton} ${styles.lock} ${phone.hitArea}`}
            onClick={onLock}
          >
            Lock
          </button>
        ) : null}
      </span>
    </header>
  );
}
