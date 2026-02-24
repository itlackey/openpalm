import { describe, expect, it } from "bun:test";

const svelteFile = new URL("./SecurityStep.svelte", import.meta.url).pathname;

describe("SecurityStep (ISSUE-2 — gutted password paste, security info only)", () => {
  it("does not have a password input field", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).not.toContain('type="password"');
    expect(content).not.toContain("wiz-admin");
  });

  it("does not accept an error prop", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).not.toContain("error: string");
  });

  it("shows security features information", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("Security Features");
    expect(content).toContain("cryptographically verified");
  });
});
