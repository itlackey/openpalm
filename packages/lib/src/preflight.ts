import { homedir } from "node:os";
import type { HostOS, PreflightIssue, PreflightResult } from "./types.ts";

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

async function trySpawn(cmd: string[]): Promise<{ exitCode: number; output: string } | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    await proc.exited;
    return { exitCode: proc.exitCode ?? 1, output: await new Response(proc.stdout).text() };
  } catch {
    return null;
  }
}

export async function checkPortDetailed(port: number = 80): Promise<PreflightIssue | null> {
  // Try lsof first
  const lsof = await trySpawn(["lsof", `-iTCP:${port}`, "-sTCP:LISTEN", "-P", "-n"]);
  if (lsof) {
    if (lsof.exitCode === 0) {
      const lines = lsof.output.trim().split("\n").slice(0, 3).join("\n");
      return {
        code: "port_conflict", severity: "fatal",
        message: `Port ${port} is already in use by another process.`,
        detail: `OpenPalm needs port ${port} for its web interface.\n${lines}`,
        meta: { port },
      };
    }
    return null; // lsof ran — port is free
  }

  // Fallback to ss
  const ss = await trySpawn(["ss", "-tln"]);
  if (ss?.output.includes(`:${port} `)) {
    return {
      code: "port_conflict", severity: "fatal",
      message: `Port ${port} is already in use by another process.`,
      detail: `OpenPalm needs port ${port} for its web interface.`,
      meta: { port },
    };
  }
  return null;
}

export async function checkDaemonRunningDetailed(
  bin: string
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

export async function runPreflightChecksDetailed(
  bin: string,
  port: number = 80
): Promise<PreflightResult> {
  const results = await Promise.all([
    checkDiskSpaceDetailed(),
    checkPortDetailed(port),
    checkDaemonRunningDetailed(bin),
  ]);
  const issues = results.filter((i): i is PreflightIssue => i !== null);
  const hasFatal = issues.some((i) => i.severity === "fatal");
  return { ok: !hasFatal, issues };
}

const GUIDANCE: Record<HostOS, string> = {
  macos: "Install Docker Desktop:\n  https://www.docker.com/products/docker-desktop/\n  Or: brew install --cask docker",
  linux: "Install Docker Engine:\n  curl -fsSL https://get.docker.com | sh\n  Then: sudo systemctl start docker",
  windows: "Install Docker Desktop:\n  https://www.docker.com/products/docker-desktop/\n  Or: winget install Docker.DockerDesktop",
  unknown: "Install Docker Desktop:\n  https://www.docker.com/products/docker-desktop/",
};

export function noRuntimeGuidance(os: HostOS): string {
  return `\nDocker is not installed.\nOpenPalm runs inside containers and needs Docker installed first.\n\n${GUIDANCE[os] ?? GUIDANCE.unknown}\n\nAfter installing, rerun this installer.\n`;
}

export function noComposeGuidance(): string {
  return "Docker Compose is not available.\nIncluded in Docker Desktop. For Linux:\n  sudo apt-get install docker-compose-plugin\n  Or: https://docs.docker.com/compose/install/";
}
