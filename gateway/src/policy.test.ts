import { describe, expect, it } from "bun:test";
import { validateToolRequest } from "./policy.ts";

describe("tool firewall", () => {
  it("blocks non allowlisted safe_fetch domain", () => {
    const result = validateToolRequest({
      toolName: "safe_fetch",
      args: { url: "https://evil.example.net" },
      allowlistDomains: ["example.com"]
    });
    expect(result.allowed).toBe(false);
  });

  it("requires approval for high risk tool", () => {
    const result = validateToolRequest({
      toolName: "shell_exec",
      args: { cmd: "rm -rf /" },
      allowlistDomains: ["example.com"],
      approval: { approved: false }
    });
    expect(result.allowed).toBe(false);
  });
});
