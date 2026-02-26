import { homedir } from "node:os";
import type { HostOS, ContainerPlatform, PreflightIssue, PreflightResult } from "./types.ts";

/**
 * Check available disk space on the home directory.
 * Returns a typed issue if less than 3 GB is available.
 */
export async function checkDiskSpaceDetailed(): Promise<PreflightIssue | null> {
  try {
    const proc = Bun.spawn(["df", "-Pk", homedir()], {
      stdout: "pipe",
      stderr: "ignore",
    });
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    const lines = output.trim().split("\n");
    if (lines.length < 2) return null;

    const parts = lines[1].split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    if (isNaN(availKB)) return null;

    if (availKB < 3_000_000) {
      const availGB = Number((availKB / 1_048_576).toFixed(1));
      return {
        code: "disk_low",
        severity: "warning",
        message: `Low disk space — only ~${availGB} GB available.`,
        detail: "OpenPalm needs roughly 3 GB for container images and data.",
        meta: { availableGb: availGB },
      };
    }
  } catch {
    // df not available (e.g. some Windows environments)
  }
  return null;
}

/**
 * Check if a port is already in use.
 * Returns a typed issue if the port is occupied.
 */
export async function checkPortDetailed(port: number = 80): Promise<PreflightIssue | null> {
  try {
    const lsof = Bun.spawn(["lsof", `-iTCP:${port}`, "-sTCP:LISTEN", "-P", "-n"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    await lsof.exited;
    if (lsof.exitCode === 0) {
      const output = await new Response(lsof.stdout).text();
      const lines = output.trim().split("\n").slice(0, 3).join("\n");
      return {
        code: "port_conflict",
        severity: "fatal",
        message: `Port ${port} is already in use by another process.`,
        detail: `OpenPalm needs port ${port} for its web interface.\n${lines}`,
        meta: { port },
      };
    }
  } catch {
    try {
      const ss = Bun.spawn(["ss", "-tln"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      await ss.exited;
      const output = await new Response(ss.stdout).text();
      if (output.includes(`:${port} `)) {
        return {
          code: "port_conflict",
          severity: "fatal",
          message: `Port ${port} is already in use by another process.`,
          detail: `OpenPalm needs port ${port} for its web interface.`,
          meta: { port },
        };
      }
    } catch {
      // Neither lsof nor ss available — skip check
    }
  }
  return null;
}

/**
 * Check if the Docker daemon is running.
 * Returns a typed issue if the daemon is unreachable.
 */
export async function checkDaemonRunningDetailed(
  bin: string,
  _platform: ContainerPlatform
): Promise<PreflightIssue | null> {
  try {
    const proc = Bun.spawn([bin, "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      return {
        code: "daemon_unavailable",
        severity: "fatal",
        message: "Docker is installed but the daemon is not running.",
        detail:
          process.platform === "darwin"
            ? "Open Docker Desktop and wait for it to start, then rerun."
            : "Start the Docker service:\n  sudo systemctl start docker",
        meta: { runtime: "docker", command: `${bin} info` },
      };
    }
  } catch {
    return {
      code: "daemon_check_failed",
      severity: "fatal",
      message: `Could not verify that the ${bin} daemon is running.`,
      meta: { runtime: "docker", command: `${bin} info` },
    };
  }
  return null;
}

/**
 * Run all preflight checks and return a structured result with typed issues.
 */
export async function runPreflightChecksDetailed(
  bin: string,
  platform: ContainerPlatform,
  port: number = 80
): Promise<PreflightResult> {
  const results = await Promise.all([
    checkDiskSpaceDetailed(),
    checkPortDetailed(port),
    checkDaemonRunningDetailed(bin, platform),
  ]);
  const issues = results.filter((i): i is PreflightIssue => i !== null);
  const hasFatal = issues.some((i) => i.severity === "fatal");
  return { ok: !hasFatal, issues };
}

/**
 * Return user-friendly install guidance when Docker is not found.
 */
export function noRuntimeGuidance(os: HostOS): string {
  const lines: string[] = [
    "",
    "Docker is not installed.",
    "",
    "OpenPalm runs inside containers and needs Docker installed first.",
    "",
  ];

  switch (os) {
    case "macos":
      lines.push(
        "For macOS, install Docker Desktop:",
        "",
        "  Docker Desktop (free for personal use):",
        "    https://www.docker.com/products/docker-desktop/",
        "",
        "  Or via Homebrew:",
        "    brew install --cask docker",
      );
      break;
    case "linux":
      lines.push(
        "For Linux, install Docker Engine + Compose plugin:",
        "",
        "  Quick install (official script):",
        "    curl -fsSL https://get.docker.com | sh",
        "",
        "  Or follow the guide at:",
        "    https://docs.docker.com/engine/install/",
        "",
        "  After installing, make sure Docker is running:",
        "    sudo systemctl start docker",
      );
      break;
    default:
      lines.push(
        "Download Docker Desktop (free for personal use):",
        "  https://www.docker.com/products/docker-desktop/",
        "",
        "Or install via winget:",
        "  winget install Docker.DockerDesktop",
      );
      break;
  }

  lines.push("", "After installing, rerun this installer.", "");
  return lines.join("\n");
}

/**
 * Return user-friendly compose-not-available guidance.
 */
export function noComposeGuidance(_platform: ContainerPlatform): string {
  return [
    "Docker Compose is not available.",
    "",
    "Docker Compose is included in Docker Desktop.",
    "For Docker Engine on Linux, install the Compose plugin:",
    "  sudo apt-get install docker-compose-plugin",
    "Or: https://docs.docker.com/compose/install/",
  ].join("\n");
}
