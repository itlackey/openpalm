import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("architecture review remediation contract", () => {
  it("requires every finding heading to include remediation status", () => {
    const content = readFileSync("ARCHITECTURE-REVIEW.md", "utf8");
    const lines = content.split(/\r?\n/);

    const headingIndexes: Array<{ index: number; heading: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith("### ")) {
        headingIndexes.push({ index: i, heading: lines[i] });
      }
    }

    for (let i = 0; i < headingIndexes.length; i += 1) {
      const start = headingIndexes[i].index;
      const end = i + 1 < headingIndexes.length ? headingIndexes[i + 1].index : lines.length;
      const block = lines.slice(start, end).join("\n");
      expect(block.includes("Remediation status")).toBe(true);
    }
  });
});
