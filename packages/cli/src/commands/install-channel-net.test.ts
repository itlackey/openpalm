import { describe, expect, it } from "bun:test";

const installFile = new URL("./install.ts", import.meta.url).pathname;

describe("ISSUE-12 — Minimal compose has no unused channel_net", () => {
  it("minimal compose only declares assistant_net network", async () => {
    const content = await Bun.file(installFile).text();
    // Extract the minimalCompose template string
    const minimalStart = content.indexOf("const minimalCompose = `");
    const minimalEnd = content.indexOf("`;", minimalStart);
    const minimalCompose = content.slice(minimalStart, minimalEnd);

    expect(minimalCompose).toContain("assistant_net");
    expect(minimalCompose).not.toContain("channel_net");
  });

  it("minimal compose services only use assistant_net", async () => {
    const content = await Bun.file(installFile).text();
    const minimalStart = content.indexOf("const minimalCompose = `");
    const minimalEnd = content.indexOf("`;", minimalStart);
    const minimalCompose = content.slice(minimalStart, minimalEnd);

    // All network references should be assistant_net only
    const networkRefs = minimalCompose.match(/networks:\s*\[([^\]]+)\]/g) || [];
    for (const ref of networkRefs) {
      expect(ref).toContain("assistant_net");
      expect(ref).not.toContain("channel_net");
    }
  });
});
