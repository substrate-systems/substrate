export default function Philosophy() {
  const axioms = [
    "Systems precede products.",
    "Constraints enable clarity.",
    "Foundations compound.",
    "Simplicity is not reduction.",
  ];

  return (
    <section className="py-32 sm:py-40 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="space-y-12 sm:space-y-16">
          {axioms.map((axiom, index) => (
            <p
              key={index}
              className="text-xl sm:text-2xl md:text-3xl text-neutral-300 font-light tracking-tight animate-fade-in"
              style={{
                animationDelay: `${index * 150}ms`,
                animationFillMode: "backwards",
              }}
            >
              {axiom}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
