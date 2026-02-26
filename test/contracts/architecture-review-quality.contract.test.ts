import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type FindingBlock = {
  heading: string;
  body: string;
};

function parseFindingBlocks(markdown: string): FindingBlock[] {
  const lines = markdown.split(/\r?\n/);
  const headings: Array<{ index: number; heading: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("### ")) {
      headings.push({ index: i, heading: lines[i] });
    }
  }

  const blocks: FindingBlock[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : lines.length;
    blocks.push({ heading: headings[i].heading, body: lines.slice(start, end).join("\n") });
  }
  return blocks;
}

describe("architecture review quality contract", () => {
  it("keeps each finding addressed, tested, and documented", () => {
    const review = readFileSync("ARCHITECTURE-REVIEW.md", "utf8");
    const blocks = parseFindingBlocks(review);

    for (const block of blocks) {
      expect(block.body.includes("Remediation status")).toBe(true);

      const hasTestReference =
        block.body.includes(".test.ts")
        || block.body.includes("test/contracts/")
        || block.body.includes("coverage");
      expect(hasTestReference).toBe(true);
    }
  });
});
