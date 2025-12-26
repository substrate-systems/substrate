export default function SectionFade() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[22vh] sm:h-[26vh] z-[5]"
      style={{
        background: `
          linear-gradient(
            to bottom,
            transparent 0%,
            rgb(from var(--bg-base) r g b / 0.55) 60%,
            rgb(from var(--bg-base) r g b / 1) 100%
          )
        `,
      }}
    />
  );
}