import { homedir } from "node:os";
import type { HostOS, ContainerPlatform } from "./types.ts";

export type PreflightWarning = {
  message: string;
  detail?: string;
};

/**
 * Check available disk space on the home directory.
 * Returns a warning if less than 3 GB is available.
 */
export async function checkDiskSpace(): Promise<PreflightWarning | null> {
  try {
    // Use -P (POSIX) mode to guarantee single-line output per filesystem
    const proc = Bun.spawn(["df", "-Pk", homedir()], {
      stdout: "pipe",
      stderr: "ignore",
    });
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    const lines = output.trim().split("\n");
    if (lines.length < 2) return null;

    // df -Pk output: Filesystem 1024-blocks Used Available Capacity Mounted
    const parts = lines[1].split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    if (isNaN(availKB)) return null;

    if (availKB < 3_000_000) {
      const availGB = (availKB / 1_048_576).toFixed(1);
      return {
        message: `Low disk space — only ~${availGB} GB available.`,
        detail: "OpenPalm needs roughly 3 GB for container images and data.",
      };
    }
  } catch {
    // df not available (e.g. some Windows environments)
  }
  return null;
}

/**
 * Check if a port is already in use.
 */
export async function checkPort(port: number = 80): Promise<PreflightWarning | null> {
  try {
    // Try lsof first (macOS, most Linux)
    const lsof = Bun.spawn(["lsof", `-iTCP:${port}`, "-sTCP:LISTEN", "-P", "-n"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    await lsof.exited;
    if (lsof.exitCode === 0) {
      const output = await new Response(lsof.stdout).text();
      const lines = output.trim().split("\n").slice(0, 3).join("\n");
      return {
        message: `Port ${port} is already in use by another process.`,
        detail: `OpenPalm needs port ${port} for its web interface.\n${lines}`,
      };
    }
  } catch {
    // lsof not available, try ss without -p (works without root)
    try {
      const ss = Bun.spawn(["ss", "-tln"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      await ss.exited;
      const output = await new Response(ss.stdout).text();
      if (output.includes(`:${port} `)) {
        return {
          message: `Port ${port} is already in use by another process.`,
          detail: `OpenPalm needs port ${port} for its web interface.`,
        };
      }
    } catch {
      // Neither lsof nor ss available — skip check
    }
  }
  return null;
}

/**
 * @deprecated Use checkPort() instead.
 */
export async function checkPort80(): Promise<PreflightWarning | null> {
  return checkPort(80);
}

/**
 * Check if the Docker/Podman daemon is actually running.
 */
export async function checkDaemonRunning(
  bin: string,
  platform: ContainerPlatform
): Promise<PreflightWarning | null> {
  if (platform === "podman") return null; // Podman is daemonless

  try {
    const proc = Bun.spawn([bin, "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      return {
        message: `${platform === "orbstack" ? "OrbStack" : "Docker"} is installed but the daemon is not running.`,
        detail:
          process.platform === "darwin"
            ? "Open Docker Desktop (or OrbStack) and wait for it to start, then rerun."
            : "Start the Docker service:\n  sudo systemctl start docker",
      };
    }
  } catch {
    return {
      message: `Could not verify that the ${bin} daemon is running.`,
    };
  }
  return null;
}

/**
 * Run all preflight checks and return any warnings.
 */
export async function runPreflightChecks(
  bin: string,
  platform: ContainerPlatform,
  port: number = 80
): Promise<PreflightWarning[]> {
  const results = await Promise.all([
    checkDiskSpace(),
    checkPort(port),
    checkDaemonRunning(bin, platform),
  ]);
  return results.filter((w): w is PreflightWarning => w !== null);
}

/**
 * Return user-friendly install guidance when no container runtime is found.
 */
export function noRuntimeGuidance(os: HostOS): string {
  const lines: string[] = [
    "",
    "No container runtime found.",
    "",
    "OpenPalm runs inside containers and needs Docker (recommended)",
    "or Podman (experimental) installed first.",
    "",
  ];

  switch (os) {
    case "macos":
      lines.push(
        "For macOS, install ONE of:",
        "",
        "  Docker Desktop (free for personal use):",
        "    https://www.docker.com/products/docker-desktop/",
        "",
        "  OrbStack (lightweight, fast):",
        "    https://orbstack.dev/download",
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
export function noComposeGuidance(platform: ContainerPlatform): string {
  if (platform === "podman") {
    return [
      "Compose support not available.",
      "",
      "Install podman-compose:",
      "  pip install podman-compose",
      "Or: https://github.com/containers/podman-compose",
    ].join("\n");
  }
  return [
    "Compose support not available.",
    "",
    "Docker Compose is included in Docker Desktop.",
    "For Docker Engine on Linux, install the Compose plugin:",
    "  sudo apt-get install docker-compose-plugin",
    "Or: https://docs.docker.com/compose/install/",
  ].join("\n");
}
