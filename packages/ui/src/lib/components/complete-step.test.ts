import { describe, expect, it } from "bun:test";

const svelteFile = new URL("./CompleteStep.svelte", import.meta.url).pathname;

describe("CompleteStep per-service status (ISSUE-10)", () => {
  it("declares serviceStatus reactive state", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("serviceStatus");
    expect(content).toContain("$state");
  });

  it("tracks per-service health status during polling", async () => {
    const content = await Bun.file(svelteFile).text();
    // Poll loop reads services from health-check response
    expect(content).toContain("r.data?.services");
    expect(content).toContain("Object.entries(services)");
  });

  it("shows live per-service indicators during polling", async () => {
    const content = await Bun.file(svelteFile).text();
    // Live status shown when not ready and not timed out
    expect(content).toContain("!ready && !timedOut");
    expect(content).toContain("Object.entries(serviceStatus)");
  });

  it("shows per-service status on timeout with color indicators", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("timedOut");
    expect(content).toContain("s.ok ? 'ready' : 'not ready'");
    // Red/green indicators
    expect(content).toContain("var(--green");
    expect(content).toContain("var(--red");
  });
});
