export default function SectionFade() {
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[22vh] sm:h-[26vh] z-[5]"
            style={{
                background:
                    "linear-gradient(to bottom, transparent 0%, rgba(5,5,5,0.55) 70%, rgba(5,5,5,1) 100%)",
            }}
        />
    )
}