import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CliVersion = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")).version as string;

const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe",
  stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);

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
    expect(stdout).toContain(CliVersion);
  });

  it("prints version with --version flag", async () => {
    const { stdout, exitCode } = await runCli("--version");

    expect(exitCode).toBe(0);
    expect(stdout).toContain(CliVersion);
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
      "dev",
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


  it("supports dev command with subcommand validation", async () => {
    const { stderr, exitCode } = await runCli("dev");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Missing subcommand");
  });
  it("prints version with -v flag", async () => {
    const { stdout, exitCode } = await runCli("-v");

    expect(exitCode).toBe(0);
    expect(stdout).toContain(CliVersion);
  });

  it("prints help with -h flag", async () => {
    const { stdout, exitCode } = await runCli("-h");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Commands:");
  });

  it.skipIf(!dockerAvailable)("supports ps as alias for status", async () => {
    const { stderr, exitCode } = await runCli("ps");

    expect(exitCode).not.toBe(0);
    expect(stderr).not.toContain("Unknown command");
  });

  it("supports ext as alias for extensions with valid subcommand", async () => {
    // Run with isolated env: no ADMIN_TOKEN and a non-existent state dir
    // so the CLI can't authenticate — proving "list" is recognized (not "Unknown command")
    // but the command still fails (non-zero exit) because no token is available.
    const proc = Bun.spawn(["bun", "run", join(REPO_ROOT, "packages/cli/src/main.ts"), "ext", "list"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ADMIN_TOKEN: "", OPENPALM_STATE_HOME: "/tmp/nonexistent-openpalm-state" },
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const exitCode = proc.exitCode ?? 1;

    expect(exitCode).not.toBe(0);
    expect(stderr).not.toContain("Unknown command");
  });
});
