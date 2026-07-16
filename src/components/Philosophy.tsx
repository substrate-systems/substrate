"use client";

import { motion, useReducedMotion } from "framer-motion";

const statements = [
  "Your setup should survive the machine.",
  "Your memory should outlive the session.",
  "Your AI should show its sources.",
];

export default function Philosophy() {
  const shouldReduceMotion = useReducedMotion();

  return (
    <section className="relative w-full pb-32 sm:pb-40">
      <div className="mx-auto w-full max-w-3xl px-6">
        <div className="relative">
          <div
            data-narrative-connector-base="philosophy"
            aria-hidden="true"
            className="absolute bottom-5 left-[5px] top-0 w-px bg-border-default sm:left-[7px]"
          >
            <motion.div
              data-narrative-connector-signal="philosophy"
              className="absolute inset-0 origin-top bg-gradient-to-b from-transparent via-fg-secondary to-transparent motion-reduce:hidden"
              initial={false}
              whileInView={{ opacity: [0, 1, 0], scaleY: [0.2, 1, 1] }}
              viewport={{ once: true, amount: 0.2 }}
              transition={
                shouldReduceMotion
                  ? { duration: 0 }
                  : { duration: 1.2, times: [0, 0.55, 1], ease: [0.22, 1, 0.36, 1] }
              }
            />
          </div>

          <ol className="space-y-20 pt-32 sm:space-y-28 sm:pt-40">
            {statements.map((statement) => (
              <li key={statement} className="relative pl-9 sm:pl-12">
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-[0.72em] h-[11px] w-[11px] rounded-full border border-border-default bg-bg-base sm:h-[15px] sm:w-[15px]"
                />
                <motion.p
                  className="text-2xl font-light tracking-tight text-fg-secondary sm:text-3xl md:text-4xl"
                  initial={false}
                  whileInView={{
                    opacity: [1, 1, 1],
                    y: [0, -6, 0],
                    color: ["#a3a3a3", "#ffffff", "#a3a3a3"],
                  }}
                  viewport={{ once: true, amount: 0.65 }}
                  transition={
                    shouldReduceMotion
                      ? { duration: 0 }
                      : { duration: 1.15, times: [0, 0.52, 1], ease: "easeOut" }
                  }
                >
                  {statement}
                </motion.p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
