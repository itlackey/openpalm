import { describe, expect, it } from "bun:test";

const svelteFile = new URL("./CompleteStep.svelte", import.meta.url).pathname;

describe("CompleteStep readiness UX (rec-06)", () => {
  it("declares phase and checks reactive state", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("phase");
    expect(content).toContain("checks");
    expect(content).toContain("$state");
  });

  it("defines readiness phase labels for UX display", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("PHASE_LABELS");
    expect(content).toContain("applying");
    expect(content).toContain("starting");
    expect(content).toContain("checking");
    expect(content).toContain("ready");
    expect(content).toContain("failed");
  });

  it("polls /setup/core-readiness for backend-driven phase updates", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("/setup/core-readiness");
    expect(content).toContain("pollReadiness");
  });

  it("supports retry via /setup/core-readiness/retry", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("/setup/core-readiness/retry");
    expect(content).toContain("retryReadiness");
    expect(content).toContain("Retry Readiness Check");
  });

  it("shows per-service status with color indicators", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("readiness-checks");
    expect(content).toContain("friendlyName");
    expect(content).toContain("var(--green");
    expect(content).toContain("var(--red");
  });

  it("includes diagnostics panel with service logs", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("diagnostics-panel");
    expect(content).toContain("failedServiceLogs");
    expect(content).toContain("showDiagnostics");
  });

  it("accepts initialReadiness prop from parent wizard", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("initialReadiness");
    expect(content).toContain("applySnapshot");
  });
});
