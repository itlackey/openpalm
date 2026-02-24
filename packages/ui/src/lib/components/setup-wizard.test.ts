import { describe, expect, it } from "bun:test";

const svelteFile = new URL("./SetupWizard.svelte", import.meta.url).pathname;

describe("SetupWizard — ISSUE-2 (password in profile step)", () => {
  it("reads password from wiz-profile-password in the profile step", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("wiz-profile-password");
  });

  it("validates password minimum length of 8 characters", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("password.length < 8");
    expect(content).toContain("Password must be at least 8 characters");
  });

  it("validates password confirmation matches", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("password !== password2");
    expect(content).toContain("Passwords do not match");
  });

  it("sends password in the setup.profile payload", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("payload: { name, email, password }");
  });

  it("calls setAdminToken with the password after profile save", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("setAdminToken(password)");
  });

  it("passes error prop to ProfileStep", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("<ProfileStep error={stepError}");
  });

  it("does not pass error prop to SecurityStep", async () => {
    const content = await Bun.file(svelteFile).text();
    // SecurityStep should be rendered without error prop
    expect(content).toContain("<SecurityStep />");
    expect(content).not.toContain("<SecurityStep error=");
  });

  it("does not have security step setAdminToken handler", async () => {
    const content = await Bun.file(svelteFile).text();
    // The old pattern: reading wiz-admin input in security step
    expect(content).not.toContain("wiz-admin");
  });
});

describe("SetupWizard — ISSUE-9 (finishSetup error handling)", () => {
  it("has a finishInProgress state guard", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("finishInProgress");
    expect(content).toContain("if (finishInProgress) return");
  });

  it("checks setup.channels result before proceeding", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("channelsResult.ok");
    expect(content).toContain("Could not save channel configuration");
  });

  it("handles channel service.up failures non-fatally", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("upResult.ok");
    expect(content).toContain("console.warn");
  });

  it("checks setup.step result before completing", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("stepResult.ok");
    expect(content).toContain("Could not save step progress");
  });

  it("checks setup.complete result and shows actionable error on failure", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("completeResult.ok");
    expect(content).toContain("Setup failed:");
    expect(content).toContain("Finish Setup");
  });

  it("disables the Finish Setup button during operation", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("disabled={finishInProgress}");
    expect(content).toContain("Finishing...");
  });

  it("displays wizard-level step errors", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("{#if stepError && !isComplete}");
    expect(content).toContain('class="wiz-error visible"');
  });

  it("wraps finishSetup in try/finally to reset finishInProgress", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("} finally {");
    expect(content).toContain("finishInProgress = false");
  });
});
