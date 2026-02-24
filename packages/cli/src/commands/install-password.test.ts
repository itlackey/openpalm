import { describe, expect, it } from "bun:test";

const installFile = new URL("./install.ts", import.meta.url).pathname;

describe("install.ts — ISSUE-2 (softened password display)", () => {
  it("does not show the raw admin token prominently", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).not.toContain("YOUR ADMIN PASSWORD (save this!)");
    expect(content).not.toContain("yellow(generatedAdminToken)");
  });

  it("directs user to set password in the wizard", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("choose your own password in the setup wizard");
  });

  it("mentions admin password in 'What happens next' step 2", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("Create your admin password and profile");
  });
});
