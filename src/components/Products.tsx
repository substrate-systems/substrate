export default function Products() {
  return (
    <section className="py-32 sm:py-40 px-6 border-t border-neutral-800/50">
      <div className="max-w-3xl mx-auto">
        <div className="mb-16">
          <span className="text-xs uppercase tracking-[0.2em] text-neutral-500">
            Products
          </span>
        </div>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h3 className="text-2xl sm:text-3xl md:text-4xl font-light text-white tracking-tight">
              Endstate
            </h3>
            <span className="text-sm text-neutral-500 font-light">
              Coming soon
            </span>
          </div>
          <p className="text-lg sm:text-xl text-neutral-400 font-light max-w-xl">
            Deterministic state management for complex systems.
          </p>
        </div>
      </div>
    </section>
  );
}
