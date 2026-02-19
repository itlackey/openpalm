import { describe, expect, it } from "bun:test";
import { ALLOWED } from "../../controller/server.ts";
import { readFileSync } from "node:fs";

describe("contract: controller API", () => {
  it("allowed service list matches docs", () => {
    const docs = readFileSync("docs/api-reference.md", "utf8");
    for (const service of ALLOWED) {
      expect(docs.includes(service)).toBe(true);
    }
  });
});
