import { describe, expect, it } from "bun:test";

const installFile = new URL("./install.ts", import.meta.url).pathname;

describe("ISSUE-16 — Report issue URLs in install failures", () => {
  it("defines a reportIssueUrl helper function", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("function reportIssueUrl(");
    expect(content).toContain("github.com/itlackey/openpalm/issues/new");
  });

  it("includes report link in runtime detection failure", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain('reportIssueUrl({ os, arch, error: "Docker not found"');
  });

  it("includes report link in image pull failure", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("reportIssueUrl({ os, arch, error: String(pullErr)");
  });

  it("includes report link in health check timeout", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain('reportIssueUrl({ os, arch, error: "Health check timeout');
  });

  it("report URL includes environment context (os, arch, error)", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("context.os");
    expect(content).toContain("context.arch");
    expect(content).toContain("context.error");
  });
});
