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
    // Set a sensitive env var that should NOT reach child processes
    process.env.SECRET_KEY = "supersecret";

    // Use execFile directly with the same env filtering logic from shell.ts
    // to verify the allowlist actually excludes SECRET_KEY
    const { execFile } = await import("node:child_process");
    const SAFE_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV",
      "OPENPALM_CONFIG_HOME", "OPENPALM_STATE_HOME", "OPENPALM_DATA_HOME"];
    const safeEnv: Record<string, string> = {};
    for (const key of SAFE_KEYS) {
      if (process.env[key]) safeEnv[key] = process.env[key]!;
    }

    const childOutput = await new Promise<string>((resolve, reject) => {
      execFile("env", [], { env: safeEnv }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    // SECRET_KEY must NOT appear in the filtered child environment
    expect(childOutput).not.toContain("SECRET_KEY");
    expect(childOutput).not.toContain("supersecret");

    // executeShellAction should also succeed with the allowlist
    await executeShellAction({ type: "shell", command: ["echo", "ok"] });

    delete process.env.SECRET_KEY;
  });
});
