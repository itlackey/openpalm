import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const readmeFile = join(import.meta.dir, "..", "..", "README.md");

describe("ISSUE-5 — No npx/bunx install path in docs", () => {
  it("README does not mention npx", async () => {
    const content = await Bun.file(readmeFile).text();
    expect(content).not.toContain("npx ");
    expect(content).not.toContain("npx@");
  });

  it("README does not mention bunx", async () => {
    const content = await Bun.file(readmeFile).text();
    expect(content).not.toContain("bunx ");
    expect(content).not.toContain("bunx@");
  });

  it("README install instructions use curl/powershell scripts", async () => {
    const content = await Bun.file(readmeFile).text();
    expect(content).toContain("curl -fsSL");
    expect(content).toContain("install.sh");
  });
});
