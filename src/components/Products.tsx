export default function Products() {
  return (
    <section className="relative w-full py-32 sm:py-40 border-t border-border-subtle">
      <div className="mx-auto w-full max-w-[72rem] px-6">
        <div className="mb-12">
          <span className="text-label uppercase text-fg-tertiary">
            Products
          </span>
        </div>

        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h3 className="text-heading-lg sm:text-display-sm md:text-display text-fg-primary">
              Endstate
            </h3>
            <span className="text-body-sm text-fg-tertiary">
              Coming soon
            </span>
          </div>
          <p className="text-body-lg sm:text-heading-sm text-fg-secondary max-w-shell-sm">
            Deterministic state management for complex systems.
          </p>
        </div>
      </div>
    </section>
  );
}
