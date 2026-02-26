import type { ContainerPlatform, HostOS, HostArch } from "./types.ts";

export function detectOS(): HostOS {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

export function detectArch(): HostArch {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      return "amd64";
  }
}

export async function detectRuntime(): Promise<ContainerPlatform | null> {
  const dockerBin = await Bun.which("docker");
  if (dockerBin) return "docker";
  return null;
}

export function resolveSocketPath(os: HostOS): string {
  if (os === "windows") return "//./pipe/docker_engine";
  return "/var/run/docker.sock";
}

export const COMPOSE_BIN = { bin: "docker", subcommand: "compose" } as const;

export async function validateRuntime(bin: string, subcommand: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, subcommand, "version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
