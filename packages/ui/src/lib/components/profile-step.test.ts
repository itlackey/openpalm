import { describe, expect, it } from "bun:test";

const svelteFile = new URL("./ProfileStep.svelte", import.meta.url).pathname;

describe("ProfileStep (ISSUE-2 — admin password UX)", () => {
  it("has a password input field with id wiz-profile-password", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain('id="wiz-profile-password"');
  });

  it("has a confirm password input with id wiz-profile-password2", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain('id="wiz-profile-password2"');
  });

  it("accepts an error prop for validation messages", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("error: string");
    expect(content).toContain("{#if error}");
  });

  it("uses type=password and autocomplete=new-password for password fields", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain('type="password"');
    expect(content).toContain('autocomplete="new-password"');
  });
});
