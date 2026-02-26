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

export async function detectRuntime(_os: HostOS): Promise<ContainerPlatform | null> {
  const dockerBin = await Bun.which("docker");
  if (dockerBin) return "docker";

  const podmanBin = await Bun.which("podman");
  if (podmanBin) return "podman";

  return null;
}

export function resolveSocketPath(platform: ContainerPlatform, os: HostOS): string {
  switch (platform) {
    case "docker":
      if (os === "windows") return "//./pipe/docker_engine";
      return "/var/run/docker.sock";
    case "podman":
      if (os === "linux") {
        const uid = process.getuid?.() ?? 1000;
        return `/run/user/${uid}/podman/podman.sock`;
      }
      if (os === "windows") return "//./pipe/podman-machine-default";
      return "/var/run/docker.sock";
  }
}

export function resolveComposeBin(platform: ContainerPlatform): { bin: string; subcommand: string } {
  switch (platform) {
    case "docker":
      return { bin: "docker", subcommand: "compose" };
    case "podman":
      return { bin: "podman", subcommand: "compose" };
  }
}

export function resolveSocketUri(platform: ContainerPlatform, os: HostOS): string {
  const socketPath = resolveSocketPath(platform, os);
  if (os === "windows") return `npipe://${socketPath}`;
  return `unix://${socketPath}`;
}

export function resolveInContainerSocketPath(_platform: ContainerPlatform): string {
  return "/var/run/docker.sock";
}

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
