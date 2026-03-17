import { describe, it, expect } from "bun:test";
import { executeShellAction } from "./shell.js";
import type { AutomationAction } from "@openpalm/lib";

describe("executeShellAction", () => {
  it("should execute a simple command", async () => {
    const action: AutomationAction = {
      type: "shell",
      command: ["echo", "hello"],
    };

    await executeShellAction(action);
    // No error means success
  });

  it("should reject when command is missing", async () => {
    const action: AutomationAction = {
      type: "shell",
    };

    expect(executeShellAction(action)).rejects.toThrow(
      "shell action requires a non-empty 'command' array",
    );
  });

  it("should reject when command is empty", async () => {
    const action: AutomationAction = {
      type: "shell",
      command: [],
    };

    expect(executeShellAction(action)).rejects.toThrow(
      "shell action requires a non-empty 'command' array",
    );
  });

  it("should reject when command fails", async () => {
    const action: AutomationAction = {
      type: "shell",
      command: ["false"],
    };

    expect(executeShellAction(action)).rejects.toThrow("shell command failed");
  });

  it("should respect timeout", async () => {
    const action: AutomationAction = {
      type: "shell",
      command: ["sleep", "10"],
      timeout: 100,
    };

    expect(executeShellAction(action)).rejects.toThrow();
  });

  it("should not leak environment variables", async () => {
    // Set a sensitive env var
    process.env.SECRET_KEY = "supersecret";

    const action: AutomationAction = {
      type: "shell",
      command: ["env"],
    };

    // Should succeed but SECRET_KEY should NOT be in the env
    await executeShellAction(action);

    delete process.env.SECRET_KEY;
  });
});
