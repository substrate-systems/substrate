import Link from "next/link";
import styles from "./private-shell.module.css";

export function PrivateShell({ children }: { children: React.ReactNode }) {
  return (
    <main className={`${styles.page} brand-exomem`}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link className={styles.mark} href="/exomem" aria-label="Exomem">
            Exomem
          </Link>
          <span className={styles.privacy}>Private workspace</span>
        </header>
        {children}
      </div>
    </main>
  );
}

export { styles as privateShellStyles };
