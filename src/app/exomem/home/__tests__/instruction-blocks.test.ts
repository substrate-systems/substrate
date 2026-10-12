import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INVOLVEMENT_LEVELS } from "@/components/exomem/involvement-levels";
import { INSTRUCTION_BLOCKS } from "../instruction-blocks.generated";

// The blocks are generated from the exomem repo's docs/prominence.md by
// scripts/sync-exomem-instruction-blocks.mjs. Home and the journey copy them into
// people's assistants, so a wrong mapping pastes the wrong behaviour.

describe("each level hands over its own block from the Exomem doc", () => {
  it("gives every level a distinct, non-empty block", () => {
    // A level that maps to nothing, or two levels that collapse to the same block,
    // would paste the wrong behaviour into someone's assistant.
    const blocks = INVOLVEMENT_LEVELS.map((level) => level.block);
    for (const [index, text] of blocks.entries()) {
      assert.ok(text.trim().length > 0, `${INVOLVEMENT_LEVELS[index]?.key} has no block`);
    }
    assert.equal(new Set(blocks).size, INVOLVEMENT_LEVELS.length, "levels must not collapse");
  });

  it("does not hand a level the block of another", () => {
    // The generator maps doc headings to levels by their first word. The light,
    // balanced and maximal blocks each open with their own level name, so a swapped
    // heading shows here. The off block carries no such line.
    for (const level of INVOLVEMENT_LEVELS.filter((option) => option.key !== "off")) {
      assert.ok(
        level.block.includes(`Exomem prominence: ${level.key.toUpperCase()}.`),
        `${level.key} returns another level's block`
      );
    }
  });

  it("covers exactly the levels the generated blocks define", () => {
    // The sync script keeps its own list of levels; the switch reads this one. A
    // level added to one list cannot end up unselectable or without a block.
    assert.deepEqual(
      Object.keys(INSTRUCTION_BLOCKS).sort(),
      INVOLVEMENT_LEVELS.map((level) => level.key).sort()
    );
  });
});
