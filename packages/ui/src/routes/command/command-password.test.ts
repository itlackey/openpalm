import { describe, expect, it } from "bun:test";

const commandFile = new URL("./+server.ts", import.meta.url).pathname;

describe("command/+server.ts — ISSUE-2 (password handling)", () => {
  it("imports upsertEnvVar from @openpalm/lib/env", async () => {
    const content = await Bun.file(commandFile).text();
    expect(content).toContain("import { upsertEnvVar }");
  });

  it("imports RUNTIME_ENV_PATH from config", async () => {
    const content = await Bun.file(commandFile).text();
    expect(content).toContain("RUNTIME_ENV_PATH");
  });

  it("persists password via upsertEnvVar in setup.profile handler", async () => {
    const content = await Bun.file(commandFile).text();
    // The handler should write ADMIN_TOKEN when password is valid
    expect(content).toContain("upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password)");
  });

  it("has a secret.set_admin_password command handler", async () => {
    const content = await Bun.file(commandFile).text();
    expect(content).toContain("secret.set_admin_password");
  });

  it("validates minimum password length in set_admin_password", async () => {
    const content = await Bun.file(commandFile).text();
    // Should reject passwords shorter than 8 characters
    expect(content).toContain("password.length < 8");
    expect(content).toContain("invalid_password");
  });

  it("restarts admin after password change", async () => {
    const content = await Bun.file(commandFile).text();
    // After setting ADMIN_TOKEN, should restart admin to pick up new env
    expect(content).toContain("composeAction('restart', 'admin')");
  });
});
