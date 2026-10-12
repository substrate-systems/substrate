// How much Exomem joins in: the four levels, what each does (the design handoff's
// Appendix C), and the instruction block an app without the plugin needs for each.
// The journey's level switch and Home's both read this list.
//
// The block text is not written here. It is the generated, verbatim copy of the
// exomem repo's docs/prominence.md; see home/assistant-instructions.ts for how it
// is kept in step.

import { INSTRUCTION_BLOCKS } from "@/app/exomem/home/instruction-blocks.generated";

export type InvolvementLevelKey = keyof typeof INSTRUCTION_BLOCKS;

export type InvolvementLevel = {
  key: InvolvementLevelKey;
  /** The segment's label. */
  label: string;
  /** One line under the switch: what the level does. */
  description: string;
  /** The instructions to paste into an app without the plugin. */
  block: string;
};

/** In switch order, from least to most involved. */
export const INVOLVEMENT_LEVELS: readonly InvolvementLevel[] = [
  {
    key: "off",
    label: "Off",
    description: "Exomem stays connected but waits. It searches or saves only when you ask it to.",
    block: INSTRUCTION_BLOCKS.off,
  },
  {
    key: "light",
    label: "Light",
    description:
      "Searches when you ask, or when the topic is clearly its. Saves only when you ask.",
    block: INSTRUCTION_BLOCKS.light,
  },
  {
    key: "balanced",
    label: "Balanced",
    description: "Searches when the topic matches. Saves conclusions. Stays quiet.",
    block: INSTRUCTION_BLOCKS.balanced,
  },
  {
    key: "maximal",
    label: "Maximal",
    description: "Searches before every real question. Saves every step forward, and says so.",
    block: INSTRUCTION_BLOCKS.maximal,
  },
];

export function involvementLevel(key: InvolvementLevelKey): InvolvementLevel {
  return INVOLVEMENT_LEVELS.find((level) => level.key === key)!;
}
