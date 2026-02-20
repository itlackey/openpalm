import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");

/**
 * Helper function to run the CLI as a subprocess and capture output
 */
async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", join(REPO_ROOT, "packages/cli/src/main.ts"), ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}

describe("CLI entry point", () => {
  it("prints help with no arguments", async () => {
    const { stdout, exitCode } = await runCli();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("openpalm");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Commands:");
  });

  it("prints help with --help flag", async () => {
    const { stdout, exitCode } = await runCli("--help");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Commands:");
  });

  it("prints help with help command", async () => {
    const { stdout, exitCode } = await runCli("help");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Commands:");
  });

  it("prints version with version command", async () => {
    const { stdout, exitCode } = await runCli("version");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("0.0.5");
  });

  it("prints version with --version flag", async () => {
    const { stdout, exitCode } = await runCli("--version");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("0.0.5");
  });

  it("exits with error for unknown command", async () => {
    const { stderr, exitCode } = await runCli("fakecmd");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown command");
  });

  it("help output lists all commands", async () => {
    const { stdout, exitCode } = await runCli("help");

    expect(exitCode).toBe(0);

    // Verify all command names are present
    const commands = [
      "install",
      "uninstall",
      "update",
      "start",
      "stop",
      "restart",
      "logs",
      "status",
      "extensions",
      "version",
      "help"
    ];

    for (const command of commands) {
      expect(stdout).toContain(command);
    }
  });

  it("help output lists install options", async () => {
    const { stdout, exitCode } = await runCli("help");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Install options:");
    expect(stdout).toContain("--runtime");
    expect(stdout).toContain("--no-open");
    expect(stdout).toContain("--ref");
  });

  it("help output lists uninstall options", async () => {
    const { stdout, exitCode } = await runCli("help");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Uninstall options:");
    expect(stdout).toContain("--remove-all");
    expect(stdout).toContain("--remove-images");
    expect(stdout).toContain("--yes");
  });

  it("supports ext as alias for extensions", async () => {
    const { stderr, exitCode } = await runCli("ext");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Missing subcommand");
  });

  it("prints version with -v flag", async () => {
    const { stdout, exitCode } = await runCli("-v");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("0.0.5");
  });

  it("prints help with -h flag", async () => {
    const { stdout, exitCode } = await runCli("-h");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Commands:");
  });

  it("supports ps as alias for status", async () => {
    const { stderr, exitCode } = await runCli("ps");

    expect(exitCode).not.toBe(0);
    expect(stderr).not.toContain("Unknown command");
  });

  it("supports ext as alias for extensions with valid subcommand", async () => {
    const { stderr, exitCode } = await runCli("ext", "list");

    expect(exitCode).not.toBe(0);
    expect(stderr).not.toContain("Unknown command");
  });
});
