/**
 * GitHub's Octocat mark.
 *
 * Inlined rather than imported: lucide-react removed all brand icons in v1, so
 * there is no `Github` export to use. GitHub's brand guidelines permit the mark
 * for linking to GitHub provided it is not modified or recoloured beyond
 * `currentColor`, so the path below is the official one, unaltered.
 *
 * There is deliberately no PyPI equivalent. PyPI's mark is the Python blocks
 * logo, which reads as "Python" rather than "PyPI" and would be parsed as a
 * language badge next to this one — and "PyPI", "Python Package Index" and the
 * blocks logos are registered PSF trademarks. Plain text is clearer and safer.
 */
export function GithubMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
