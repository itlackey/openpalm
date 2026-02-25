import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CliVersion = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")).version as string;

const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe",
  stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);

// Commands like ps/status need both Docker AND the OpenPalm state directory
// (compose file + env file). Without them, docker compose returns exit code 1.
const stateHome = Bun.env.OPENPALM_STATE_HOME
  || (Bun.env.XDG_STATE_HOME ? join(Bun.env.XDG_STATE_HOME, "openpalm") : undefined)
  || join(homedir(), ".local", "state", "openpalm");
const openpalmInstalled = dockerAvailable
  && existsSync(join(stateHome, "docker-compose.yml"))
  && existsSync(join(stateHome, ".env"));

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
  // ── Help flags ──────────────────────────────────────────────────────────
  for (const { label, args } of [
    { label: "no arguments", args: [] as string[] },
    { label: "--help flag", args: ["--help"] },
    { label: "help command", args: ["help"] },
    { label: "-h flag", args: ["-h"] },
  ]) {
    it(`prints help with ${label}`, async () => {
      const { stdout, exitCode } = await runCli(...args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("openpalm");
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("Commands:");
    });
  }

  // ── Version flags ──────────────────────────────────────────────────────
  for (const arg of ["version", "--version", "-v"]) {
    it(`prints version with ${arg}`, async () => {
      const { stdout, exitCode } = await runCli(arg);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(CliVersion);
    });
  }

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
      "automation",
      "channel",
      "dev",
      "extensions",
      "help",
      "install",
      "logs",
      "restart",
      "service",
      "start",
      "status",
      "stop",
      "uninstall",
      "update",
      "version"
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

  // ── Subcommand validation ──────────────────────────────────────────────
  for (const cmd of ["ext", "dev", "service", "channel", "automation"]) {
    it(`${cmd} without subcommand exits with error`, async () => {
      const { stderr, exitCode } = await runCli(cmd);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Missing subcommand");
    });
  }

  it("does not expose admin command", async () => {
    const { stderr, exitCode } = await runCli("admin");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown command");
  });

  it.skipIf(!openpalmInstalled)("supports ps as alias for status", async () => {
    const { stderr, exitCode } = await runCli("ps");

    // docker compose ps returns 0 even when no services are running,
    // but requires the compose file and env file to exist on disk.
    // This test is skipped when OpenPalm is not installed (CI, fresh machines).
    expect(exitCode).toBe(0);
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
