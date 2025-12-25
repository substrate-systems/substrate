export default function Products() {
  return (
    <section className="relative w-full py-32 sm:py-40 border-t border-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-6">
        <div className="mb-16">
          <span className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
            Products
          </span>
        </div>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h3 className="text-2xl sm:text-3xl md:text-4xl font-light tracking-tight text-fg-primary">
              Endstate
            </h3>
            <span className="text-sm font-light text-fg-tertiary">
              Coming soon
            </span>
          </div>
          <p className="text-lg sm:text-xl font-light text-fg-secondary max-w-xl">
            Deterministic state management for complex systems.
          </p>
        </div>
      </div>
    </section>
  );
}
